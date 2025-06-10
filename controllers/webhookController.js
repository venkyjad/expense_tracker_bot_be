const userModel = require('../models/userModel');
const expenseModel = require('../models/expenseModel');
const ocrService = require('../services/ocr');
const aiParser = require('../services/ai-parser');
const { sendWhatsAppMessage } = require('../services/twilio');

// State for onboarding
const userOnboardingState = new Map();

exports.handleWebhook = async (req, res) => {
  try {
    const { Body, From, MessageStatus, MessageSid, NumMedia, MediaContentType0, MediaUrl0 } = req.body;
    if (MessageStatus) {
      return res.sendStatus(200);
    }
    const phone = From.replace('whatsapp:', '');
    // Onboarding: join
    if (Body.toLowerCase().includes('join')) {
      const existingUser = await userModel.getUserByPhone(phone);
      if (existingUser) {
        await sendWhatsAppMessage(phone, `Welcome back, ${existingUser.name}! 👋\n\nYou can send me a receipt to track your expenses.`);
      } else {
        userOnboardingState.set(phone, { step: 'name', data: {} });
        await sendWhatsAppMessage(phone, "Welcome to Reimburzi! 👋\n\nLet's get you set up. What's your name?");
      }
      return;
      // return res.sendStatus(200);
    }
    // Onboarding: name/email
    const onboardingState = userOnboardingState.get(phone);
    if (onboardingState) {
      switch (onboardingState.step) {
        case 'name':
          onboardingState.data.name = Body.trim();
          onboardingState.step = 'email';
          userOnboardingState.set(phone, onboardingState);
          await sendWhatsAppMessage(phone, `Thanks ${onboardingState.data.name}! What's your email address?`);
          break;
        case 'email':
          const email = Body.trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            await sendWhatsAppMessage(phone, "That doesn't look like a valid email address. Please try again:");
            return res.sendStatus(200);
          }
          const newUser = await userModel.createUser({
            phone,
            name: onboardingState.data.name,
            email
          });
          userOnboardingState.delete(phone);
          await sendWhatsAppMessage(phone, `Great! You're all set up, ${newUser.name}! 🎉\n\nYou can now send me receipts to track your expenses. Just take a photo of your receipt and send it to me.`);
          break;
      }
      return;
      //return res.sendStatus(200);
    }
    // Existing user check
    const user = await userModel.getUserByPhone(phone);
    if (!user) {
      await sendWhatsAppMessage(phone, "Welcome! To get started, please send 'join' to begin setting up your account.");
      // return res.sendStatus(200);
      return;
    }
    // Receipt image processing
    if (NumMedia === '1' && MediaContentType0 && MediaContentType0.startsWith('image/')) {
      try {
        const extractedText = await ocrService.extractTextFromImage(MediaUrl0);
        if (extractedText) {
          const parsedReceipt = await aiParser.parseReceiptWithAI(extractedText);
          await expenseModel.createExpense({
            user_id: user.id,
            image_url: MediaUrl0,
            merchant: parsedReceipt.merchant,
            amount: parsedReceipt.amount,
            date: parsedReceipt.date,
            category: parsedReceipt.category,
            currency: parsedReceipt.currency,
            language: parsedReceipt.language,
            status: 'pending'
          });
          await sendWhatsAppMessage(phone, "✅ Receipt saved");
        }
      } catch (error) {
        await sendWhatsAppMessage(phone, "❌ Sorry, I couldn't process your receipt. Please try again.");
      }
      //return res.sendStatus(200);
      return;
    }
    // Text message: summary/help
    const lowerBody = Body.toLowerCase();
    if (lowerBody.includes('summary')) {
      let period = 'week';
      if (lowerBody.includes('month')) period = 'month';
      if (lowerBody.includes('year') || lowerBody.includes('ytd')) period = 'ytd';
      // For simplicity, just reply with a stub (move summary logic to a controller if needed)
      await sendWhatsAppMessage(phone, `Summary for ${period} is not yet implemented in this refactor.`);
    } else {
      await sendWhatsAppMessage(phone, `Hi ${user.name}! 👋\n\nI can help you track your expenses. Just send me a photo of your receipt, or type 'summary' to see your spending overview.\n\nYou can also try:\n- 'summary month' for monthly view\n- 'summary year' for year-to-date view`);
    }
    //res.sendStatus(200);
    return;
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
}; 