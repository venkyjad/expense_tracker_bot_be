const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { PrismaClient } = require('@prisma/client');
const twilio = require('twilio');
const { extractTextFromImage } = require('./services/ocr');
const { parseReceiptWithAI } = require('./services/ai-parser');
const crypto = require('crypto');
const { OpenAI } = require('openai');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Initialize Prisma client
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());
// Add support for Twilio webhook data
app.use(express.urlencoded({ extended: true }));

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Add OpenAI configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Get or create user by phone number
 * @param {string} phone - Phone number in format 'whatsapp:+1234567890'
 * @returns {Promise<string>} - User ID
 */
async function getOrCreateUser(phone) {
  try {
    // Remove 'whatsapp:' prefix if present
    const cleanPhone = phone.replace('whatsapp:', '');
    
    // Check if user exists
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', cleanPhone)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 is "no rows returned"
      throw fetchError;
    }

    if (existingUser) {
      return existingUser.id;
    }

    const now = new Date().toISOString();

    // Create new user with UUID and timestamps
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert([
        {
          id: crypto.randomUUID(), // Generate UUID for the id field
          phone: cleanPhone,
          name: 'WhatsApp User', // Default name
          company_id: 'default', // Default company
          created_at: now,
          updated_at: now
        }
      ])
      .select('id')
      .single();

    if (createError) throw createError;
    return newUser.id;
  } catch (error) {
    console.error('Error in getOrCreateUser:', error);
    throw error;
  }
}

/**
 * Send WhatsApp message using Twilio
 * @param {string} to - Phone number in format 'whatsapp:+1234567890'
 * @param {string} message - Message to send
 */
async function sendWhatsAppMessage(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to: to
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        supabase: 'connected'
      }
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      services: {
        database: 'disconnected',
        supabase: 'unknown'
      }
    });
  }
});

// Webhook for WhatsApp messages via Twilio
app.post('/api/webhook', async (req, res) => {
  try {
    // Log the entire request body for debugging
    console.log('Received webhook request:', {
      body: req.body,
      headers: req.headers,
      contentType: req.headers['content-type']
    });

    const messageSid = req.body.MessageSid;
    const from = req.body.From; // format: 'whatsapp:+1234567890'
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const body = req.body.Body;
    let imageUrl = null;
    let extractedText = null;
    let parsedReceipt = null;

    console.log('Parsed message details:', {
      messageSid,
      from,
      numMedia,
      body
    });

    if (numMedia > 0) {
      // Twilio sends MediaUrl{N} and MediaContentType{N} for each media
      // We'll just take the first image
      imageUrl = req.body.MediaUrl0;
      
      try {
        // Extract text from the image using Google Cloud Vision
        extractedText = await extractTextFromImage(imageUrl);
        console.log('Extracted text from image:', extractedText);

        if (extractedText) {
          // Parse the extracted text using AI
          parsedReceipt = await parseReceiptWithAI(extractedText);
          console.log('Parsed receipt:', parsedReceipt);

          // Get or create user
          const userId = await getOrCreateUser(from);

          const now = new Date().toISOString();

          // Save to Supabase
          const { data: expense, error: saveError } = await supabase
            .from('expenses')
            .insert([
              {
                id: crypto.randomUUID(), // Generate UUID for the id field
                user_id: userId,
                image_url: imageUrl,
                merchant: parsedReceipt.merchant,
                amount: parsedReceipt.amount,
                date: parsedReceipt.date,
                category: parsedReceipt.category,
                currency: parsedReceipt.currency,
                language: parsedReceipt.language,
                status: 'pending', // Default status
                created_at: now,
                updated_at: now
              }
            ])
            .select()
            .single();

          if (saveError) throw saveError;

          // Send success message
          await sendWhatsAppMessage(from, "✅ Receipt saved. Want a summary of this week?");
        }
      } catch (error) {
        console.error('Error processing image:', error);
        await sendWhatsAppMessage(from, "❌ Sorry, I couldn't process your receipt. Please try again.");
        throw error;
      }

      // Respond to webhook
      return res.status(200).json({
        message: 'Image received and processed',
        phone: from,
        image_url: imageUrl,
        extracted_text: extractedText,
        parsed_receipt: parsedReceipt
      });
    } else {
      // No image, just log the phone number and message
      console.log(`Received message from ${from}: ${body}`);
      return res.status(200).json({
        message: 'Text message received',
        phone: from,
        body: body
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/expense', async (req, res) => {
  try {
    const {
      user_id,
      image_url,
      merchant,
      amount,
      date,
      category,
      currency,
      language,
      status
    } = req.body;

    const { data, error } = await supabase
      .from('expenses')
      .insert([
        {
          user_id,
          image_url,
          merchant,
          amount,
          date,
          category,
          currency,
          language,
          status
        }
      ]);

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    console.error('Error saving expense:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/user/:phone/expenses', async (req, res) => {
  try {
    const { phone } = req.params;

    // First get the user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .single();

    if (userError) throw userError;
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Then get their expenses
    const { data: expenses, error: expensesError } = await supabase
      .from('expenses')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });

    if (expensesError) throw expensesError;
    res.json(expenses);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add summary route
//Last 7 days (default)
//http://localhost:3000/summary/+1234567890
//Current month
//http://localhost:3000/summary/+1234567890?period=month
//Year to date
//http://localhost:3000/summary/+1234567890?period=ytd
app.get('/summary/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { period = 'week' } = req.query; // Default to week if not specified
    
    // Validate phone number format
    if (!phone || !phone.startsWith('+')) {
      return res.status(400).json({ error: 'Invalid phone number format. Must start with +' });
    }

    // Validate period
    if (!['week', 'month', 'ytd'].includes(period)) {
      return res.status(400).json({ error: 'Invalid period. Must be one of: week, month, ytd' });
    }

    // Validate Twilio WhatsApp number
    const twilioWhatsAppNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioWhatsAppNumber) {
      return res.status(500).json({ error: 'Twilio WhatsApp number not configured' });
    }
    
    // Get user ID from phone number
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .single();

    console.log('phone-->', phone);
    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate start date based on period
    const startDate = new Date();
    switch (period) {
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setDate(1); // First day of current month
        break;
      case 'ytd':
        startDate.setMonth(0, 1); // January 1st of current year
        break;
    }

    // Fetch expenses for the selected period
    const { data: expenses, error: expensesError } = await supabase
      .from('expenses')
      .select('*')
      .eq('user_id', user.id)
      .gte('date', startDate.toISOString())
      .order('date', { ascending: false });

    if (expensesError) {
      throw expensesError;
    }

    // If no expenses found, return early
    if (!expenses || expenses.length === 0) {
      const periodText = {
        week: 'last 7 days',
        month: 'this month',
        ytd: 'this year'
      }[period];

      const noExpensesMessage = `You haven't recorded any expenses in the ${periodText}. Send me a receipt to get started! 📝`;
      
      // Send message via WhatsApp
      const message = await twilioClient.messages.create({
        body: noExpensesMessage,
        from: `whatsapp:${twilioWhatsAppNumber}`,
        to: `whatsapp:${phone}`
      });

      return res.json({ 
        success: true, 
        summary: noExpensesMessage,
        spendingData: {
          totalSpend: 0,
          categoryBreakdown: {},
          currency: 'AED',
          period
        },
        messageSid: message.sid 
      });
    }

    // Group expenses by category and calculate totals
    const categoryTotals = expenses.reduce((acc, expense) => {
      const category = expense.category || 'Uncategorized';
      acc[category] = (acc[category] || 0) + expense.amount;
      return acc;
    }, {});

    // Calculate total spend
    const totalSpend = expenses.reduce((sum, expense) => sum + expense.amount, 0);

    // Prepare data for OpenAI
    const spendingData = {
      totalSpend,
      categoryBreakdown: categoryTotals,
      currency: 'AED', // Assuming AED as default currency
      period
    };

    // Generate summary using OpenAI
    const periodText = {
      week: 'last 7 days',
      month: 'this month',
      ytd: 'this year'
    }[period];

    const prompt = `You are a friendly financial assistant. Here is the user's spending breakdown for the ${periodText}:
Total spend: ${spendingData.totalSpend} ${spendingData.currency}
Category breakdown: ${JSON.stringify(spendingData.categoryBreakdown)}

Generate a WhatsApp-friendly summary with the following structure:
1. A friendly greeting with an emoji
2. A table showing the top 3 spending categories with their amounts and percentages
3. A brief insight or recommendation
4. A closing message with relevant emojis

Format the response like this:
*Hey there! 🌟*

*Your ${periodText} spending summary:*
\`\`\`
Category        Amount    %
----------------------------
${Object.entries(spendingData.categoryBreakdown)
  .sort(([,a], [,b]) => b - a)
  .slice(0, 3)
  .map(([category, amount]) => {
    const percentage = ((amount / spendingData.totalSpend) * 100).toFixed(1);
    return `${category.padEnd(12)} ${amount.toFixed(2)} ${percentage}%`;
  })
  .join('\n')}
----------------------------
Total          ${spendingData.totalSpend.toFixed(2)} 100%
\`\`\`

[Your insight here]

[Closing message with emojis]

Keep the tone friendly and conversational. Use markdown formatting for better readability.`;

    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-3.5-turbo",
      max_tokens: 200,
      temperature: 0.7
    });

    const summary = completion.choices[0].message.content;

    // Send summary via WhatsApp
    const message = await twilioClient.messages.create({
      body: summary,
      from: `whatsapp:${twilioWhatsAppNumber}`,
      to: `whatsapp:${phone}`
    });

    res.json({ 
      success: true, 
      summary,
      spendingData,
      messageSid: message.sid 
    });

  } catch (error) {
    console.error('Error generating summary:', error);
    res.status(500).json({ 
      error: 'Failed to generate summary',
      details: error.message 
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 