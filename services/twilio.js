const twilio = require('twilio');
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

exports.sendWhatsAppMessage = async (to, body, retries = 3) => {
  try {
    const message = await twilioClient.messages.create({
      body,
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to: `whatsapp:${to}`
    });
    return message;
  } catch (error) {
    if (error.code === 63038 && retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return exports.sendWhatsAppMessage(to, body, retries - 1);
    }
    throw error;
  }
}; 