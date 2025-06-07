const OpenAI = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Parse receipt text using OpenAI GPT-4
 * @param {string} ocrText - Text extracted from receipt image
 * @returns {Promise<Object>} - Parsed receipt data
 */
async function parseReceiptWithAI(ocrText) {
  try {
    const prompt = `Parse the following receipt text and extract the following information in JSON format:
    - merchant: The name of the store/merchant
    - amount: The total amount paid (as a float)
    - date: The date of purchase (in ISO format YYYY-MM-DD)
    - category: Choose from [Food, Travel, Office, Shopping, Fuel, Groceries, Other]
    - currency: The currency used (e.g., USD, EUR, AED)
    - language: The language of the receipt (e.g., en, ar, fr)

    Receipt text:
    ${ocrText}

    Return a valid JSON object with no additional text or explanation. Example format:
    {
      "merchant": "Starbucks",
      "amount": 22.00,
      "date": "2025-05-25",
      "category": "food",
      "currency": "AED",
      "language": "ar"
    }`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a smart financial assistant. You take OCR-extracted receipt text (possibly noisy and in any language, including Arabic or English), and return structured data as clean JSON. Always return valid JSON with no additional text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2
    });

    // Extract the response content and parse it as JSON
    const content = response.choices[0].message.content.trim();
    console.log('Raw AI response:', content);
    
    // Parse the response content as JSON
    const parsedData = JSON.parse(content);
    console.log('Parsed receipt data:', parsedData);
    
    return parsedData;
  } catch (error) {
    console.error('Error parsing receipt with AI:', error);
    throw error;
  }
}

module.exports = {
  parseReceiptWithAI
}; 