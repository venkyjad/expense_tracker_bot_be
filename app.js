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

// Add state management for user onboarding
const userOnboardingState = new Map();

/**
 * Get or create user by phone number
 * @param {string} phone - Phone number in format 'whatsapp:+1234567890'
 * @returns {Promise<string>} - User ID
 */
async function getOrCreateUser(phone) {
  try {
    // Remove 'whatsapp:' prefix if present
    // const cleanPhone = phone.replace('whatsapp:', '');
    
    // Check if user exists
    console.log('getOrCreateUser,phone-->', phone);
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
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
          phone: phone,
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

// Add rate limit handling
const sendWhatsAppMessage = async (to, body, retries = 3) => {
  try {
    const message = await twilioClient.messages.create({
      body,
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to: `whatsapp:${to}`
    });
    return message;
  } catch (error) {
    if (error.code === 63038 && retries > 0) {
      // Rate limit hit, wait and retry
      console.log(`Rate limit hit, retrying in 1 second... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return sendWhatsAppMessage(to, body, retries - 1);
    }
    throw error;
  }
};

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
    const { Body, From, MessageStatus, MessageSid } = req.body;
    console.log('Received webhook:', req.body);

    // Handle message status updates
    if (MessageStatus) {
      console.log(`Message ${MessageSid} status: ${MessageStatus}`);
      // return res.sendStatus(200);
      return;
    }

    // Extract phone number from From field
    const phone = From.replace('whatsapp:', '');
    console.log('Processing message from:', phone);

    // Check if this is a new user joining
    if (Body.toLowerCase().includes('join')) {
      // Check if user exists
      const { data: existingUser, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('phone', phone)
        .single();

      if (userError && userError.code !== 'PGRST116') {
        throw userError;
      }

      if (existingUser) {
        // User exists, send welcome back message
        await sendWhatsAppMessage(phone, `Welcome back, ${existingUser.name}! 👋\n\nYou can send me a receipt to track your expenses.`);
      } else {
        // New user, start onboarding
        userOnboardingState.set(phone, {
          step: 'name',
          data: {}
        });

        await sendWhatsAppMessage(phone, "Welcome to Reimburzi! 👋\n\nLet's get you set up. What's your name?");
      }
      // return res.sendStatus(200);
      return
    }

    // Handle onboarding responses
    const onboardingState = userOnboardingState.get(phone);
    if (onboardingState) {
      switch (onboardingState.step) {
        case 'name':
          // Save name and ask for email
          onboardingState.data.name = Body.trim();
          onboardingState.step = 'email';
          userOnboardingState.set(phone, onboardingState);

          await sendWhatsAppMessage(phone, `Thanks ${onboardingState.data.name}! What's your email address?`);
          break;

        case 'email':
          // Validate email format
          const email = Body.trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          
          if (!emailRegex.test(email)) {
            await sendWhatsAppMessage(phone, "That doesn't look like a valid email address. Please try again:");
            // return res.sendStatus(200);
            return;
          }

          // Save user data
          const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert([
              {
                id: crypto.randomUUID(),
                phone,
                name: onboardingState.data.name,
                email,
                company_id: 'default',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }
            ])
            .select()
            .single();

          if (createError) {
            throw createError;
          }

          // Clear onboarding state
          userOnboardingState.delete(phone);

          // Send welcome message
          await sendWhatsAppMessage(phone, `Great! You're all set up, ${newUser.name}! 🎉\n\nYou can now send me receipts to track your expenses. Just take a photo of your receipt and send it to me.`);
          break;
      }
      // return res.sendStatus(200);
      return;
    }

    // Handle receipt processing for existing users
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    if (userError) {
      if (userError.code === 'PGRST116') {
        // User not found, prompt to join
        await sendWhatsAppMessage(phone, "Welcome! To get started, please send 'join' to begin setting up your account.");
      } else {
        throw userError;
      }
      // return res.sendStatus(200);
      return;
    }

    // Process receipt image
    if (req.body.NumMedia === '1' && req.body.MediaContentType0.startsWith('image/')) {
      // ... existing receipt processing code ...
      imageUrl = req.body.MediaUrl0;
       // format: 'whatsapp:+1234567890'
      try {
        // Extract text from the image using Google Cloud Vision
        extractedText = await extractTextFromImage(imageUrl);
        console.log('Extracted text from image:', extractedText);

        if (extractedText) {
          // Parse the extracted text using AI
          parsedReceipt = await parseReceiptWithAI(extractedText);
          console.log('Parsed receipt:', parsedReceipt);

          // Get or create user
          const userId = await getOrCreateUser(phone);

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
          await sendWhatsAppMessage(phone, "✅ Receipt saved");
        }
      } catch (error) {
        console.error('Error processing image:', error);
        await sendWhatsAppMessage(phone, "❌ Sorry, I couldn't process your receipt. Please try again.");
        throw error;
      }

      // Respond to webhook
      return res.status(200).json({
        message: 'Image received and processed',
        phone: phone,
        image_url: imageUrl,
        extracted_text: extractedText,
        parsed_receipt: parsedReceipt
      });
    } else {
      // Handle text messages
      const lowerBody = Body.toLowerCase();
      
      if (lowerBody.includes('summary')) {
        // Extract period from message
        let period = 'week';
        if (lowerBody.includes('month')) period = 'month';
        if (lowerBody.includes('year') || lowerBody.includes('ytd')) period = 'ytd';
        
        // Redirect to summary endpoint
        const summaryUrl = `${req.protocol}://${req.get('host')}/summary/${phone}?period=${period}`;
        const response = await fetch(summaryUrl);
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate summary');
        }
      } else {
        // Send help message
        await sendWhatsAppMessage(phone, `Hi ${user.name}! 👋\n\nI can help you track your expenses. Just send me a photo of your receipt, or type 'summary' to see your spending overview.\n\nYou can also try:\n- 'summary month' for monthly view\n- 'summary year' for year-to-date view`);
      }
    }
    return;
    // res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
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
      const message = await sendWhatsAppMessage(phone, noExpensesMessage);

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
    const message = await sendWhatsAppMessage(phone, summary);

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