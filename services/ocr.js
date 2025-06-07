const vision = require('@google-cloud/vision');
const twilio = require('twilio');
const axios = require('axios');

// Initialize the Vision client
const client = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Download image from Twilio and convert to base64
 * @param {string} mediaUrl - Twilio media URL
 * @returns {Promise<string>} - Base64 encoded image
 */
async function downloadAndConvertToBase64(mediaUrl) {
  try {
    // Download the media using axios with Twilio credentials
    const response = await axios.get(mediaUrl, {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      responseType: 'arraybuffer'
    });

    // Convert the response data to base64
    const base64Image = Buffer.from(response.data).toString('base64');
    return base64Image;
  } catch (error) {
    console.error('Error downloading image from Twilio:', error);
    throw error;
  }
}

/**
 * Extract text from an image using Google Cloud Vision OCR
 * @param {string} mediaUrl - Twilio media URL
 * @returns {Promise<string>} - Extracted text from the image
 */
async function extractTextFromImage(mediaUrl) {
  try {
    console.log('Downloading image from Twilio:', mediaUrl);
    
    // Download and convert image to base64
    const base64Image = await downloadAndConvertToBase64(mediaUrl);
    
    // Perform text detection on the base64 image
    const [result] = await client.textDetection({
      image: {
        content: base64Image
      }
    });
    
    const detections = result.textAnnotations;

    if (!detections || detections.length === 0) {
      console.log('No text detected in the image');
      return '';
    }

    // The first result contains the entire text
    const fullText = detections[0].description;
    console.log('Extracted text:', fullText);
    
    return fullText;
  } catch (error) {
    console.error('Error extracting text from image:', error);
    throw error;
  }
}

module.exports = {
  extractTextFromImage
}; 