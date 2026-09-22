const axios = require('axios');

const zohoBookApi = axios.create({
    baseURL: 'https://www.zohoapis.in/books/v3'
});

const zohoAuthData = {
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  grant_type: 'refresh_token'
};

let cachedZohoToken = null;
let cachedZohoTokenTimestamp = 0;

const getZohoAccessToken = async () => {
  if (cachedZohoToken && Date.now() - cachedZohoTokenTimestamp < 3600000) {
    return cachedZohoToken;
  }

  const response = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token',
    null,
    { params: zohoAuthData }
  );

  cachedZohoToken = response.data.access_token;
  cachedZohoTokenTimestamp = Date.now();
  return cachedZohoToken;
};

module.exports = { zohoBookApi, getZohoAccessToken };