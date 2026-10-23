require("dotenv").config();
const User = require("../models/userModel");
const Product = require("../models/productModel");
const Cart = require("../models/cartModel");
const Address = require("../models/addressModal");
const Coupon = require("../models/couponModel");
const Order = require("../models/orderModel");
const ShiprocketAPI = require("../models/shiprocketapi");
const asyncHandler = require("express-async-handler");
const { generateToken } = require("../config/jwtToken");
const validateMongoDbId = require("../utils/validateMongodbId");
const { generateRefreshToken } = require("../config/refreshtoken");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { sendResendEmail } = require("../utils/sendResendEmail");
const { Worker } = require("worker_threads");
const fs = require("fs");
const bcrypt = require("bcrypt");
const { getZohoAccessToken, zohoBookApi } = require("../utils/zohoapi");
const { createShipment, shiprocketLogin } = require("../utils/shiprocketapi");
const {
  deductMedishieldCoins,
  addMedishieldCoins,
  getAvailableMedishieldCoins,
} = require("../utils/medishieldCoins");
const { OAuth2Client } = require("google-auth-library");
const appleSignin = require("apple-signin-auth");
const googleClient = new OAuth2Client();

const BASE_URL = process.env.BASE_URL;
const axios = require("axios");
const zohoAuthData = {
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  grant_type: "refresh_token",
};

const org = process.env.ZOHO_ORG_ID;
let accessTokenGlobalzoho = null;
let accessTokenGlobalTimestatmp = null;
const zohoAuth = async () => {
  // check if access token is present and not expired
  if (
    accessTokenGlobalzoho &&
    Date.now() - accessTokenGlobalTimestatmp < 3600000
  ) {
    return accessTokenGlobalzoho;
  }
  const zohoAuthResponse = await axios.post(`
    https://accounts.zoho.in/oauth/v2/token?refresh_token=${zohoAuthData.refresh_token}&client_id=${zohoAuthData.client_id}&client_secret=${zohoAuthData.client_secret}&grant_type=${zohoAuthData.grant_type}
    `);
  console.log(zohoAuthResponse.data.access_token);
  const accessToken = zohoAuthResponse.data.access_token;
  // store the access token in memory for 1 hour
  accessTokenGlobalzoho = accessToken;
  accessTokenGlobalTimestatmp = Date.now();

  return accessToken;
};

const createUser = asyncHandler(async (req, res) => {
  try {
    const email = req.body.email;
    const iscreatingAdmin = req.body.role === "admin" ? true : false;
    if (iscreatingAdmin) {
      return res.json({
        message: "Admin Creation is not allowed by users",
      });
    }
    if (!req.body.googleAuthToken) {
      delete req.body.googleAuthToken;
    }
    const findUser = await User.findOne({ email: email });
    if (!findUser) {
      const accessToken = await zohoAuth();
      // create contact on zoho also
      const customerPayload = {
        contact_name: email,
        contact_type: "customer",
        contact_subtype: "individual",
        contact_persons: [
          {
            first_name: req.body.firstname,
            last_name: req.body.lastname,
            email: email,
            phone: req.body.mobile,
          },
        ],
      };

      const customer = await zohoBookApi.post(
        `/contacts?organization_id=${org}`,
        customerPayload,
        {
          headers: {
            authorization: `Zoho-oauthtoken ${accessToken}`,
          },
          timeout: 30000,
        },
      );
      console.log(customer);
      const newUser = await User.create({
        ...req.body,
        zohoCustomerId: customer.data.contact.contact_id,
      });
      // give user 100 coins for signup
      const user = await User.findById(newUser._id);
      // user.medishieldcoins = 50;
      // generate referral code
      const referralCode = user._id.toString().slice(0, 9);
      user.referralCode = referralCode;
      await user.save();
      // give referrer 100 coins for referring
      let referer = req.body.referralCode;
      if (referer) {
        const referrer = await User.findOne({ referralCode: referer });
        if (referrer) {
          referrer.medishieldcoins = referrer.medishieldcoins + 100;
          await referrer.save();
        }
      }
      res.json({
        newUser,
        token: generateToken(newUser?._id),
        email: newUser?.email,
      });
    } else {
      throw new Error("User Already Exists Please Login");
    }
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const createAdmin = asyncHandler(async (req, res) => {
  const email = req.body.email;
  const findUser = await User.findOne({
    email: email,
  });
  if (!findUser) {
    const newUser = await User.create(req.body);
    const referralCode = newUser._id.toString().slice(0, 9);
    newUser.referralCode = referralCode;
    (await newUser.save()).populate("permission");
    res.json({
      newUser,
    });
  } else {
    throw new Error("Admin Already Exists");
  }
});

const deleteAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  try {
    const deletedAdmin = await User.findOneAndDelete({ email: id });
    res.json({
      deletedAdmin,
    });
  } catch (error) {
    throw new Error(error);
  }
});

const updateAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    let hashedPassword = req?.body?.password;
    if (req?.body?.password) {
      const salt = bcrypt.genSaltSync(10);
      hashedPassword = await bcrypt.hash(hashedPassword, salt);
    }
    const updatedAdmin = await User.findByIdAndUpdate(
      id,
      {
        firstname: req?.body?.firstname,
        lastname: req?.body?.lastname,
        email: req?.body?.email,
        permission: req?.body?.permission,
        password: hashedPassword,
      },
      {
        new: true,
      },
    ).populate("permission");
    res.json(updatedAdmin);
  } catch (error) {
    throw new Error(error);
  }
});

const isEmailVerified = asyncHandler(async (req, res) => {
  const token = req.params.token;
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded?.id);
  if (user.isEmailVerified) {
    res.json({
      message: "true",
    });
  } else {
    res.json({
      message: "false",
    });
  }
});

const sendVerificationEmail = asyncHandler(async (req, res) => {
  const token = req.params.id;
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded?.id);
  req.activityActor = user;
  const emailtoken = jwt.sign(
    {
      data: user.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );
  try {
    await sendResendEmail(
      (to = user.email),
      (subject = "Email Verification"),
      (html = `<!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Email Verification</title>
          <style>
              /* Reset styles */
              body, table, td, a {
                  -webkit-text-size-adjust: 100%;
                  -ms-text-size-adjust: 100%;
              }
      
              table, td {
                  mso-table-lspace: 0pt;
                  mso-table-rspace: 0pt;
              }
      
              img {
                  -ms-interpolation-mode: bicubic;
              }
      
              /* Template styles */
              body {
                  margin: 0;
                  padding: 0;
                  font-family: Arial, sans-serif;
                  background-color: #f4f4f4;
              }
      
              table {
                  width: 100%;
                  background-color: #ffffff;
              }
      
              td {
                  padding: 20px;
              }
      
              .header {
                  background-color: #333333;
                  color: #ffffff;
                  text-align: center;
              }
      
              .content {
                  padding-top: 30px;
                  padding-bottom: 30px;
                  text-align: center;
              }
      
              .footer {
                  background-color: #333333;
                  color: #ffffff;
                  text-align: center;
              }
      
              @media only screen and (max-width: 600px) {
                  /* Adjust table sizes for mobile */
                  table {
                      width: 100%;
                  }
      
                  .content {
                      padding-left: 10px;
                      padding-right: 10px;
                  }
              }
          </style>
      </head>
      <body>
          <table>
              <tr>
                  <td class="header">
                      <h1>Email Verification</h1>
                  </td>
              </tr>
              <tr>
                  <td class="content">
                      <p>Hi,</p>
                      <p>Please follow this link to verify your email address. This link is valid for the next 10 minutes:</p>
                      <p><a href="${BASE_URL}/api/user/verifyEmail/${emailtoken}">Click Here</a></p>
                  </td>
              </tr>
              <tr>
                  <td class="footer">
                      <p>Thank you!</p>
                      <p>MediShield Healthcare PVT. LTD.</p>
                  </td>
              </tr>
          </table>
      </body>
      </html>
      `),
    );
    res.json({
      message: "Email Sent",
    });
  } catch (error) {
    throw new Error(error);
  }
});

const verifyEmail = asyncHandler(async (req, res) => {
  const verificationToken = req.params.token;
  const decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
  const user = await User.find({ email: decoded.data });
  req.activityActor = user[0];
  // Verifying the JWT token
  jwt.verify(
    verificationToken,
    process.env.JWT_SECRET,
    function (err, decoded) {
      if (err) {
        console.log(err);
        res.send(
          "Email verification failed, possibly the link is invalid or expired",
        );
      } else {
        // Rendering a beautiful card in HTML
        const htmlResponse = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Email Verification</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              background-color: #f4f4f4;
              margin: 0;
              padding: 0;
            }

            .card {
              background-color: #ffffff;
              border-radius: 10px;
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
              padding: 20px;
              margin: 20px auto;
              max-width: 400px;
              text-align: center;
            }

            h1 {
              color: #333333;
            }

            p {
              color: #555555;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Email Verified Successfully</h1>
            <p>Your email has been successfully verified.</p>
          </div>
        </body>
        </html>
      `;

        // Sending the HTML response
        res.send(htmlResponse);
        User.updateOne(
          { email: decoded.data },
          { isEmailVerified: true },
          function (err, result) {
            if (err) {
              console.log(err);
            } else {
              console.log("Email verification status updated successfully");
            }
          },
        );
      }
    },
  );
});

// Login a user
const loginUserCtrl = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  console.log("LOGIN EMAIL:", email);
  console.log("LOGIN PASSWORD:", password);
  // check if user exists or not
  const findUser = await User.findOne({ email });
  console.log("USER FOUND:", findUser);
  console.log("PASSWORD HASH:", findUser?.password);
  if (findUser && (await findUser.isPasswordMatched(password))) {
    res.cookie("refreshToken", findUser.refreshToken, {
      httpOnly: true,
      maxAge: 72 * 60 * 60 * 1000,
    });
    res.json({
      _id: findUser?._id,
      firstname: findUser?.firstname,
      lastname: findUser?.lastname,
      email: findUser?.email,
      mobile: findUser?.mobile,
      token: generateToken(findUser?._id),
    });
  } else {
    throw new Error("Invalid Credentials");
  }
});

// google uid token login
const loginWithGoogle = asyncHandler(async (req, res) => {
  const { uid } = req.params;
  // check if user exists or not
  const user = await User.findOne({ googleAuthToken: uid });
  console.log(user);
  if (user) {
    res.json({
      _id: user?._id,
      firstname: user?.firstname,
      lastname: user?.lastname,
      email: user?.email,
      mobile: user?.mobile,
      isEmailVerified: user?.isEmailVerified,
      token: generateToken(user?._id),
    });
  } else {
    throw new Error("Google Signin Failed Please use normal login");
  }
});



const appleOAuthLogin = asyncHandler(async (req, res) => {
  const { identityToken, firstName, lastName, referralCode } = req.body;

  if (!identityToken) {
    return res.status(400).json({
      message: "Apple identity token is required",
    });
  }

  const appleClientId = process.env.APPLE_CLIENT_ID;

  if (!appleClientId) {
    return res.status(500).json({
      message: "Apple Client ID is not configured",
    });
  }

  let payload;

  // 1. Verify Apple's identity token
  try {
    payload = await appleSignin.verifyIdToken(identityToken, {
      audience: appleClientId,
      ignoreExpiration: false,
    });
  } catch (error) {
    console.error("Apple token verification failed:", error.message);

    return res.status(401).json({
      message: "Invalid Apple identity token",
    });
  }

  if (!payload?.sub) {
    return res.status(401).json({
      message: "Invalid Apple user identity",
    });
  }

  const appleId = payload.sub;
  const email = payload.email?.toLowerCase();

  // 2. Find existing Apple account first
  let user = await User.findOne({ appleId });

  // If Apple supplies a verified email, we can find a matching account
  if (!user && email) {
    const emailVerified =
      payload.email_verified === true ||
      payload.email_verified === "true";

    if (emailVerified) {
      user = await User.findOne({ email });
    }
  }

  if (user) {
    // Don't replace an already-linked Apple identity
    if (user.appleId && user.appleId !== appleId) {
      return res.status(409).json({
        message: "A different Apple account is linked to this user",
      });
    }

    user.appleId = appleId;

    if (email && !user.email) {
      user.email = email;
    }

    if (email && (
      payload.email_verified === true ||
      payload.email_verified === "true"
    )) {
      user.isEmailVerified = true;
    }

    await user.save();
  } else {
    // New Apple user needs an email for the current User schema
    if (!email) {
      return res.status(400).json({
        message:
          "Apple did not provide an email. Please try signing in again.",
      });
    }

    const emailVerified =
      payload.email_verified === true ||
      payload.email_verified === "true";

    if (!emailVerified) {
      return res.status(401).json({
        message: "Apple email is not verified",
      });
    }

    // 3. Create Zoho customer, like existing registration
    const accessToken = await zohoAuth();

    const customerPayload = {
      contact_name: email,
      contact_type: "customer",
      contact_subtype: "individual",
      contact_persons: [
        {
          first_name: firstName || email.split("@")[0],
          last_name: lastName || "",
          email,
        },
      ],
    };

    const customer = await zohoBookApi.post(
      `/contacts?organization_id=${org}`,
      customerPayload,
      {
        headers: {
          authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        timeout: 30000,
      }
    );

    user = await User.create({
      firstname: firstName || email.split("@")[0],
      lastname: lastName || "",
      email,
      appleId,
      isEmailVerified: true,
      zohoCustomerId: customer.data.contact.contact_id,
    });

    user.referralCode = user._id.toString().slice(0, 9);
    await user.save();

    // Apply referral reward using the existing helper
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });

      if (referrer) {
        addMedishieldCoins(referrer, 100);
        await referrer.save();
      }
    }
  }

  // 4. Issue MediShield tokens
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save();

  return res.json({
    _id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    mobile: user.mobile,
    isEmailVerified: user.isEmailVerified,
    token: generateToken(user._id),
    refreshToken,
  });
});

const isUserExists = asyncHandler(async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await User.findOne({ googleAuthToken: uid });
    console.log(user);
    if (user) {
      res.json({
        status: true,
      });
    } else {
      res.json({
        status: false,
      });
    }
  } catch (error) {
    throw new Error("User not found");
  }
});

const getUser = asyncHandler(async (req, res) => {
  const email = req.params.email;
  try {
    const user = await User.findOne({ email: email });
    res.json(user);
  } catch (error) {
    res.json({
      error: error,
    });
  }
});

// admin login
const loginAdmin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  // check if user exists or not
  const findAdmin = await User.findOne({ email }).populate("permission");
  if (!findAdmin) throw new Error("User Not Found");
  if (findAdmin.role !== "admin") throw new Error("Not Authorised");
  if (findAdmin && (await findAdmin.isPasswordMatched(password))) {
    const token = await generateToken(findAdmin?._id);
    res.cookie("token", token, {
      httpOnly: true,
    });
    res.json({
      _id: findAdmin?._id,
      firstname: findAdmin?.firstname,
      lastname: findAdmin?.lastname,
      email: findAdmin?.email,
      mobile: findAdmin?.mobile,
      token: token,
      permission: findAdmin?.permission,
    });
  } else {
    throw new Error("Invalid Credentials");
  }
});

const getUserPermissions = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const user = await User.findById(_id).populate("permission");
    res.json({
      permission: user.permission.permissions,
    });
  } catch (error) {
    throw new Error(error);
  }
});

// handle refresh token
const handleRefreshToken = asyncHandler(async (req, res) => {
  const cookie = req.body;
  if (!cookie?.refreshToken) throw new Error("No Refresh Token in Cookies");
  const refreshToken = cookie.refreshToken;
  const user = await User.findOne({ refreshToken });
  if (!user) throw new Error(" No Refresh token present in db or not matched");
  jwt.verify(refreshToken, process.env.JWT_SECRET, (err, decoded) => {
    if (err || user.id !== decoded.id) {
      throw new Error("There is something wrong with refresh token");
    }
    const accessToken = generateToken(user?._id);
    res.json({ accessToken });
  });
});

// logout functionality
const logout = asyncHandler(async (req, res) => {
  const cookie = req.cookies;
  if (!cookie?.refreshToken) throw new Error("No Refresh Token in Cookies");
  const refreshToken = cookie.refreshToken;
  const user = await User.findOne({ refreshToken });
  if (!user) {
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
    });
    return res.sendStatus(204); // forbidden
  }
  req.activityActor = user;
  await User.findOneAndUpdate(refreshToken, {
    refreshToken: "",
  });
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: true,
  });
  res.sendStatus(204); // forbidden
});

// Update a user
const updatedUser = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);

  try {
    const updatedUser = await User.findByIdAndUpdate(
      _id,
      {
        firstname: req?.body?.firstname,
        lastname: req?.body?.lastname,
        email: req?.body?.email,
        mobile: req?.body?.mobile,
      },
      {
        new: true,
      },
    );
    res.json(updatedUser);
  } catch (error) {
    throw new Error(error);
  }
});


const googleOAuthLogin = asyncHandler(async (req, res) => {
  const { idToken, referralCode } = req.body;

  if (!idToken) {
    return res.status(400).json({
      message: "Google ID token is required",
    });
  }

  console.log(process.env.GOOGLE_CLIENT_ID)

  const clientIds = (process.env.GOOGLE_CLIENT_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!clientIds.length) {
    return res.status(500).json({
      message: "Google Client ID is not configured",
    });
  }

  let payload;

  // 1. Verify Google ID token
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: clientIds,
    });

    payload = ticket.getPayload();
  } catch (error) {
    return res.status(401).json({
      message: "Invalid Google ID token",
    });
  }

  if (
    !payload?.sub ||
    !payload?.email ||
    payload.email_verified !== true
  ) {
    return res.status(401).json({
      message: "Google account email is not verified",
    });
  }

  const email = payload.email.toLowerCase();

  // 2. Find existing user by Google ID or email
  let user = await User.findOne({
    $or: [
      { googleId: payload.sub },
      { email },
    ],
  });

  if (user) {
    // Do not overwrite a different linked Google identity
    if (user.googleId && user.googleId !== payload.sub) {
      return res.status(409).json({
        message: "A different Google account is linked to this user",
      });
    }

    // Link verified Google identity to an existing account
    user.googleId = payload.sub;
    user.isEmailVerified = true;

    await user.save();
  } else {
    // 3. Create Zoho customer, following existing registration logic
    const accessToken = await zohoAuth();

    const customerPayload = {
      contact_name: email,
      contact_type: "customer",
      contact_subtype: "individual",
      contact_persons: [
        {
          first_name: payload.given_name || payload.name || email,
          last_name: payload.family_name || "",
          email,
        },
      ],
    };

    const customer = await zohoBookApi.post(
      `/contacts?organization_id=${org}`,
      customerPayload,
      {
        headers: {
          authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        timeout: 30000,
      }
    );

    user = await User.create({
      firstname: payload.given_name || payload.name || email,
      lastname: payload.family_name || "",
      email,
      googleId: payload.sub,
      isEmailVerified: true,
      zohoCustomerId: customer.data.contact.contact_id,
    });

    // 4. Generate referral code, following existing registration logic
    user.referralCode = user._id.toString().slice(0, 9);
    await user.save();

    // 5. Apply referral reward if a valid referral code was supplied
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });

      if (referrer) {
        referrer.medishieldcoins =
          (referrer.medishieldcoins || 0) + 100;

        await referrer.save();
      }
    }
  }

  // 6. Issue MediShield app tokens
  const refreshToken = generateRefreshToken(user._id);

  user.refreshToken = refreshToken;
  await user.save();

  return res.json({
    _id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    mobile: user.mobile,
    isEmailVerified: user.isEmailVerified,
    token: generateToken(user._id),
    refreshToken,
  });
});
// save user Address
const saveAddress = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const existingAddress = await Address.findOne({
      address: req?.body?.address,
    });
    if (!existingAddress) {
      const address = await new Address(req.body).save();
      const updatedUser = await User.findByIdAndUpdate(
        _id,
        {
          $push: { address: address._id },
        },
        {
          new: true,
        },
      );
      res.json({ data: updatedUser.address });
    } else {
      throw new Error("Address Already Exists");
    }
  } catch (error) {
    throw new Error(error);
  }
});

const getAddresses = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const user = await User.findById(_id).populate("address");
    res.json({ data: user.address });
  } catch (error) {
    throw new Error(error);
  }
});

const deleteAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const address = await Address.findByIdAndRemove(id);
    const user = await User.findOneAndUpdate(
      { address: id },
      { $pull: { address: address._id } },
      { new: true },
    );
    res.json({ data: address });
  } catch (error) {
    throw new Error(error);
  }
});

const updateAddress = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const address = await Address.findByIdAndUpdate(
      id,
      {
        name: req?.body?.name,
        address: req?.body?.address,
        mobile: req?.body?.mobile,
        city: req?.body?.city,
        state: req?.body?.state,
        country: req?.body?.country,
        pincode: req?.body?.pincode,
      },
      {
        new: true,
      },
    );
    res.json({ data: address });
  } catch (error) {
    throw new Error(error);
  }
});

// Get all users
const getallUser = asyncHandler(async (req, res) => {
  try {
    const getUsers = await User.find({});
    res.json(getUsers);
  } catch (error) {
    throw new Error(error);
  }
});

const getAllAdmins = asyncHandler(async (req, res) => {
  try {
    const admins = await User.find({ role: "admin" }).populate("permission");
    res.json(admins);
  } catch (error) {
    throw new Error(error);
  }
});

// Get a single user
const getaUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);

  try {
    const getaUser = await User.findById(id);
    res.json({
      getaUser,
    });
  } catch (error) {
    throw new Error(error);
  }
});

const deleteaUser = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const deleteaUser = await User.findByIdAndRemove(_id);
    res.json({
      deleteaUser,
      status: "success",
    });
  } catch (error) {
    throw new Error(error);
  }
});

const updatePassword = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  const { password } = req.body;
  validateMongoDbId(_id);
  const user = await User.findById(_id);
  if (password) {
    user.password = password;
    const updatedPassword = await user.save();
    res.json(updatedPassword);
  } else {
    res.json(user);
  }
});

const forgotPasswordToken = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) throw new Error("User not found with this email");
  try {
    const token = await user.createPasswordResetToken();
    await user.save();
    const resetURL = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Password Reset</title>
      <style>
        body {
          font-family: 'Arial', sans-serif;
          background-color: #f4f4f4;
          margin: 0;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
        }
    
        .container {
          text-align: center;
          background-color: #fff;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
          width: 300px;
        }
    
        h1 {
          color: #333;
        }
    
        p {
          color: #555;
          margin-top: 10px;
          margin-bottom: 20px;
        }
    
        a.button {
          display: inline-block;
          background-color: #3498db;
          color: #fff;
          text-decoration: none;
          padding: 10px 20px;
          border-radius: 5px;
          transition: background-color 0.3s ease, color 0.3s ease;
        }
    
        a.button:hover {
          background-color: #2980b9;
        }
    
       
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Password Reset</h1>
        <p>Hi, Please follow this link to reset your password. This link is valid for the next 10 minutes.</p>
        <a href='${BASE_URL}/api/user/reset-password/${token}' class="button">Click Here</a>
      </div>
    </body>
    </html>
    `;

    sendResendEmail(
      (to = user.email),
      (subject = "Forgot Password Link"),
      (html = resetURL),
    );
    res.json({ token: token });
  } catch (error) {
    throw new Error(error);
  }
});

const resetPasswordForm = asyncHandler(async (req, res) => {
  const { token } = req.params;
  res.send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset</title>
    <style>
      body {
        font-family: 'Arial', sans-serif;
        background-color: #f4f4f4;
        margin: 0;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
      }
  
      .container {
        text-align: center;
        background-color: #fff;
        padding: 30px;
        border-radius: 8px;
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
        width: 300px;
      }
  
      h1 {
        color: #333;
      }
  
      form {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
  
      label {
        margin-top: 10px;
        color: #555;
      }
  
      input {
        width: 100%;
        padding: 10px;
        margin-top: 5px;
        margin-bottom: 15px;
        box-sizing: border-box;
        border: 1px solid #ddd;
        border-radius: 5px;
      }
  
      button {
        background-color: #3498db;
        color: #fff;
        padding: 10px 20px;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        transition: background-color 0.3s ease;
      }
  
      button:hover {
        background-color: #2980b9;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Password Reset</h1>
      <form action="${BASE_URL}/api/user/reset-password/${token}" method="post">
        <label for="password">New Password:</label>
        <input type="password" id="password" name="password" required>
        <button type="submit">Reset Password</button>
      </form>
    </div>
  </body>
  </html>  
  `);
});

const resetPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const { token } = req.params;
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });
  if (!user) throw new Error(" Token Expired, Please try again later");
  req.activityActor = user;
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  // res.json(user);
  res.send(
    `
    <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Changed</title>
  <style>
    body {
      font-family: 'Arial', sans-serif;
      background-color: #f4f4f4;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }

    .container {
      text-align: center;
      background-color: #fff;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
    }

    h1 {
      color: #333;
    }

    p {
      color: #555;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Password Changed Successfully</h1>
    <p>Your password has been changed successfully. You can now log in with your new password.</p>
  </div>
</body>
</html>
    `,
  );
});

const getWishlist = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  try {
    const findUser = await User.findById(_id).populate("wishlist");
    res.json({ data: findUser.wishlist });
  } catch (error) {
    throw new Error(error);
  }
});

// check stock availablity in zoho books
const checkStock = async (barcode, requiredStock, productId = null) => {
  try {
    console.log("========== CHECK STOCK ==========");
    console.log("SKU:", barcode);
    console.log("Required Stock:", requiredStock);
    console.log("Product ID:", productId);

    let product = null;
    let childProduct = null;

    // =========================================
    // 1. FIRST TRY: SKU SE PRODUCT FIND KARO
    // =========================================

    product = await Product.findOne({
      sku: barcode,
    });

    if (product) {
      console.log("✅ Product found directly by SKU");
      console.log("Product SKU:", product.sku);
    }

    // =========================================
    // 2. AGAR SKU SE NAHI MILA
    //    TO PRODUCT ID SE PARENT FIND KARO
    //    AUR CHILD PRODUCT ME SKU SEARCH KARO
    // =========================================

    if (!product && productId) {
      console.log("⚠️ Product not found by SKU");
      console.log("Trying parent product ID:", productId);

      const parentProduct = await Product.findById(productId);

      if (!parentProduct) {
        console.log("❌ Parent product not found");

        return {
          inStock: 0,
          itemId: null,
        };
      }

      console.log("✅ Parent product found:", parentProduct.sku);

      childProduct = parentProduct.childProducts?.find(
        (child) => child.sku === barcode
      );

      if (!childProduct) {
        console.log(
          "❌ Child product not found with SKU:",
          barcode
        );

        return {
          inStock: 0,
          itemId: null,
        };
      }

      console.log("✅ Child product found");
      console.log("Child SKU:", childProduct.sku);
      console.log("Child ID:", childProduct.id);
      console.log("Child Stock:", childProduct.max_sale_qty);

      // Child ko product ki tarah use karenge
      product = childProduct;
    }

    // =========================================
    // PRODUCT COMPLETELY NOT FOUND
    // =========================================

    if (!product) {
      console.log("❌ Product not found anywhere");

      return {
        inStock: 0,
        itemId: null,
      };
    }

    // =========================================
    // ZOHO PRODUCT AVAILABLE
    // =========================================

    if (product.zohoProductId) {
      console.log(
        "Zoho Product ID found:",
        product.zohoProductId
      );

      const accessToken = await getZohoAccessToken();

      const zohoResponse = await zohoBookApi.get(
        `/items/${product.zohoProductId}`,
        {
          params: {
            organization_id: process.env.ZOHO_ORG_ID,
          },
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      const zohoItem = zohoResponse.data.item;

      const inStock = Number(
        zohoItem.available_stock || 0
      );

      const itemId = zohoItem.item_id;

      console.log(
        "Zoho available stock:",
        inStock
      );

      console.log(
        "Required stock:",
        requiredStock
      );

      console.log(
        "Zoho Item ID:",
        itemId
      );

      // =========================================
      // DIRECT PRODUCT
      // =========================================

      if (!childProduct) {
        product.max_sale_qty = inStock;
        product.is_in_stock = inStock > 0;
        product.zohoLastSyncedAt = new Date();

        await product.save();
      }

      // =========================================
      // CHILD PRODUCT
      // =========================================

      if (childProduct) {
        console.log(
          "Child product found from parent. Updating child stock."
        );

        // Agar child schema mongoose subdocument hai
        childProduct.max_sale_qty = inStock;
        childProduct.is_in_stock = inStock > 0;

        // Parent product ko save karna hoga
        await Product.findByIdAndUpdate(
          productId,
          {
            $set: {
              "childProducts.$[child].max_sale_qty": inStock,
              "childProducts.$[child].is_in_stock":
                inStock > 0,
              "childProducts.$[child].zohoLastSyncedAt":
                new Date(),
            },
          },
          {
            arrayFilters: [
              {
                "child.sku": barcode,
              },
            ],
          }
        );
      }

      // =========================================
      // STOCK CHECK
      // =========================================

      if (inStock >= Number(requiredStock)) {
        console.log("✅ Item is in stock");

        return {
          inStock,
          itemId,
        };
      }

      console.log("❌ Item is out of stock");

      return {
        inStock,
        itemId,
      };
    }

    // =========================================
    // ZOHO PRODUCT ID NOT AVAILABLE
    // CHECK MONGODB STOCK
    // =========================================

    console.log(
      "Zoho Product ID not found, checking MongoDB stock"
    );

    const inStock = Number(
      product.max_sale_qty || 0
    );

    console.log(
      "MongoDB available stock:",
      inStock
    );

    console.log(
      "Required stock:",
      requiredStock
    );

    if (inStock >= Number(requiredStock)) {
      console.log(
        "✅ Item is in stock from MongoDB"
      );

      return {
        inStock,
        itemId: null,
      };
    }

    console.log(
      "❌ Item is out of stock from MongoDB"
    );

    return {
      inStock,
      itemId: null,
    };

  } catch (error) {
    console.log(
      "========== STOCK CHECK ERROR =========="
    );

    console.log(
      "STATUS:",
      error.response?.status
    );

    console.log(
      "DATA:",
      error.response?.data
    );

    console.log(
      "URL:",
      error.config?.url
    );

    console.log(
      "PARAMS:",
      error.config?.params
    );

    console.log(
      "ERROR:",
      error.message
    );

    console.log(
      "======================================="
    );

    throw new Error(
      "Trouble in checking availability of stock"
    );
  }
};

// user cart
const userCart = asyncHandler(async (req, res) => {
  const { product } = req.body;
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    console.log("Total count of the product", product?.totalcount);
    let { inStock, itemId } = await checkStock(
      product.variant,
      product.totalcount,
      product.productId
    );
    console.log(inStock);
    console.log(itemId);
    if (!inStock) {
      // update stock in product
      throw new Error(
        "Product is out of stock or available quantity is less than required quantity",
      );
    } else {
      const user = await User.findById(_id);
      const alreadyExistCart = await Cart.findOne({ orderby: user._id });
      if (alreadyExistCart) {
        const productExist = alreadyExistCart.products.find(
          (p) => p.variant == product.variant,
        );
        if (productExist) {
          console.log("product exist");
          console.log(productExist);
          console.log(product.price * product.count);
          console.log(
            alreadyExistCart.cartTotal + product.price * product.count,
          );
          const updatedCart = await Cart.findOneAndUpdate(
            {
              orderby: user._id,
              "products.variant": product.variant,
            },
            {
              $inc: {
                "products.$.count": product.count,
                cartTotal: product.price * product.count,
              },
            },
            { new: true },
          );
          return res.json(await updatedCart.populate("products.product"));
        } else {
          console.log("product not exist");
          console.log(product);

          // proceed to add product in cart
          const updatedCart = await Cart.findOneAndUpdate(
            { orderby: user._id },
            {
              $push: {
                products: {
                  product: product.productId,
                  count: product.count,
                  variant: product.variant,
                  price: product.price,
                  itemId: itemId,
                },
              },
              $set: {
                cartTotal:
                  alreadyExistCart.cartTotal + product.price * product.count,
              },
            },
            { new: true },
          );
          return res.json(await updatedCart.populate("products.product"));
        }
      } else {
        console.log("no cart found");
        cartTotal = product.price * product.count;
        let newCart = await new Cart({
          products: [
            {
              product: product.productId,
              count: product.count,
              variant: product.variant,
              price: product.price,
              itemId: itemId,
            },
          ],
          cartTotal,
          orderby: user?._id,
        }).save();
        result = await newCart.populate("products.product");
        return res.json(result);
      }
    }
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const removeCartItem = asyncHandler(async (req, res) => {
  const { product } = req.body;
  const { _id } = req.user;

  validateMongoDbId(_id);

  try {
    // ─────────────────────────────────────────────
    // Validate request
    // ─────────────────────────────────────────────
    if (!product?.variant) {
      return res.status(400).json({
        message: "Product variant is required",
      });
    }

    // ─────────────────────────────────────────────
    // Find user
    // ─────────────────────────────────────────────
    const user = await User.findById(_id);

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // ─────────────────────────────────────────────
    // Find user's cart
    // ─────────────────────────────────────────────
    const existingCart = await Cart.findOne({
      orderby: user._id,
    });

    if (!existingCart) {
      return res.status(404).json({
        message: "No Cart Found",
      });
    }

    // ─────────────────────────────────────────────
    // Find product by variant
    // ─────────────────────────────────────────────
    const productExist = existingCart.products.find(
      (item) =>
        String(item.variant) === String(product.variant)
    );

    if (!productExist) {
      return res.status(404).json({
        message: "Product not found in cart",
      });
    }

    // ─────────────────────────────────────────────
    // Calculate item total
    // ─────────────────────────────────────────────
    const itemPrice = Number(productExist.price || 0);
    const itemCount = Number(productExist.count || 0);

    const itemTotal = itemPrice * itemCount;

    const newCartTotal = Math.max(
      0,
      Number(existingCart.cartTotal || 0) - itemTotal
    );

    console.log("Removing cart item:", {
      variant: productExist.variant,
      price: itemPrice,
      count: itemCount,
      itemTotal,
      oldCartTotal: existingCart.cartTotal,
      newCartTotal,
    });

    // ─────────────────────────────────────────────
    // Remove item + update total
    // ─────────────────────────────────────────────
    await Cart.updateOne(
      {
        _id: existingCart._id,
      },
      {
        $pull: {
          products: {
            variant: productExist.variant,
          },
        },
        $set: {
          cartTotal: newCartTotal,
        },
      }
    );

    // ─────────────────────────────────────────────
    // IMPORTANT:
    // Fetch cart again after update
    // so populated product data is returned
    // ─────────────────────────────────────────────
    const updatedCart = await Cart.findOne({
      orderby: user._id,
    }).populate({
      path: "products.product",
    });

    // ─────────────────────────────────────────────
    // Return updated populated cart
    // ─────────────────────────────────────────────
    return res.json(updatedCart);
  } catch (error) {
    console.error("REMOVE CART ERROR:", error);
    throw new Error(
      error?.message || "Failed to remove cart item"
    );
  }
});

const getUserCart = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const cart = await Cart.findOne({ orderby: _id }).populate(
      "products.product",
    );

    if (!cart) {
      return res.json({
        data: cart,
      });
    }

    let accessToken = null;
    const zohoProducts = cart.products.filter(
      (item) => item.product?.zohoProductId,
    );

    if (zohoProducts.length > 0) {
      accessToken = await getZohoAccessToken();

      await Promise.all(
        zohoProducts.map(async (cartItem) => {
          const product = cartItem.product;

          try {
            const zohoResponse = await zohoBookApi.get(
              `/items/${product.zohoProductId}`,
              {
                params: {
                  organization_id: process.env.ZOHO_ORG_ID,
                },
                headers: {
                  Authorization: `Zoho-oauthtoken ${accessToken}`,
                },
              },
            );
            const zohoItem = zohoResponse.data.item;
            const zohoQuantity = zohoItem.available_stock;

            // MongoDB product update
            product.max_sale_qty = zohoQuantity;
            product.is_in_stock = zohoQuantity > 0;
            product.zohoLastSyncedAt = new Date();

            await product.save();
          } catch (error) {
            console.log(`Zoho sync failed for product: ${product._id}`);

            console.log("STATUS:", error.response?.status);
            console.log("DATA:", error.response?.data);
          }
        }),
      );
    }

    res.json({ data: cart });
  } catch (error) {
    throw new Error(error);
  }
});

const emptyCart = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const user = await User.findOne({ _id });
    const cart = await Cart.findOneAndRemove({ orderby: user._id });
    res.json(cart);
  } catch (error) {
    throw new Error(error);
  }
});

const createRazorpayOrder = asyncHandler(async (req, res) => {
  const Razorpay = require("razorpay");
  var instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  var options = {
    amount: Number(req.body.amount * 100),
    currency: req.body.currency,
  };
  instance.orders.create(options, function (err, order) {
    console.log(order);
    res.json(order);
  });
});

function verifyPaymentSignature(
  order_id,
  razorpay_payment_id,
  razorpay_signature,
) {
  const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
  const data = `${order_id}|${razorpay_payment_id}`;
  const generated_signature = hmac.update(data).digest("hex");

  if (generated_signature === razorpay_signature) {
    console.log("Payment is successful");
    return true;
  } else {
    console.log("Invalid signature. Payment failed.");
    return false;
  }
}

// post checkout order creation
const createOrder = asyncHandler(async (req, res) => {
  const {
    paymentId,
    amount,
    shipping,
    shippingAddress,
    msc,
    orderId,
    paymentSignature,
    couponId,
    disc,
  } = req.body;

  const { _id } = req.user;
  validateMongoDbId(_id);

  try {
    // Find coupon
    let coupon = null;

    if (couponId) {
      coupon = await Coupon.findById(couponId);
      console.log(coupon);
    }

    // Verify Razorpay signature
    const isAuthentic = verifyPaymentSignature(
      orderId,
      paymentId,
      paymentSignature,
    );

    if (!isAuthentic) {
      throw new Error("Payment Signature is not authentic invalid payment");
    }

    // Find user and cart
    const user = await User.findById(_id);

    if (!user) {
      throw new Error("User not found");
    }

    let userCart = await Cart.findOne({
      orderby: user._id,
    });

    if (!userCart || !userCart.products?.length) {
      throw new Error("Cart is empty");
    }

    /*
     * =========================================================
     * CHECK WHICH CART PRODUCTS ARE AVAILABLE IN ZOHO
     * =========================================================
     */

    const zohoProducts = userCart.products.filter((item) => item.itemId);

    console.log("Total Cart Products:", userCart.products.length);

    console.log("Zoho Products:", zohoProducts.length);

    console.log(
      "Website Only Products:",
      userCart.products.length - zohoProducts.length,
    );

    /*
     * These will remain null if there are no Zoho products
     * or if Zoho processing fails.
     */

    let invoice = null;
    let payment = null;

    /*
     * =========================================================
     * ZOHO PROCESS
     * =========================================================
     */

    if (zohoProducts.length > 0) {
      try {
        const accessToken = await zohoAuth();

        /*
         * Get/Create Zoho Customer
         */

        let customerId = user?.zohoCustomerId;

        if (!customerId) {
          const customerPayload = {
            contact_name: user.email,
            contact_type: "customer",
            contact_subtype: "individual",
            contact_persons: [
              {
                first_name: user.firstname,
                last_name: user.lastname,
                email: user?.email,
                phone: user?.mobile,
              },
            ],
          };

          const customer = await zohoBookApi.post(
            `/contacts?organization_id=${org}`,
            customerPayload,
            {
              headers: {
                authorization: `Zoho-oauthtoken ${accessToken}`,
              },
            },
          );

          // Update customer id in user
          user.zohoCustomerId = customer.data.contact.contact_id;

          await user.save();

          customerId = customer.data.contact.contact_id;
        }

        /*
         * =====================================================
         * CREATE ZOHO INVOICE
         * =====================================================
         */

        const zohoInvoicePayload = {
          customer_id: customerId,
          salesperson_name: "APP",
          is_inclusive_tax: true,
          discount: disc,
          is_discount_before_tax: false,
          discount_type: "entity_level",
          shipping_charge: shipping,

          line_items: zohoProducts.map((item) => ({
            item_id: item.itemId,
            quantity: item.count,
          })),
        };

        console.log("Zoho Invoice Payload:", zohoInvoicePayload);

        invoice = await zohoBookApi.post(
          `/invoices?organization_id=${org}`,
          zohoInvoicePayload,
          {
            headers: {
              authorization: `Zoho-oauthtoken ${accessToken}`,
            },
          },
        );

        console.log("Zoho Invoice ID:", invoice.data.invoice.invoice_id);

        /*
         * =====================================================
         * PAY ZOHO INVOICE
         * =====================================================
         */

        const invoiceId = invoice.data.invoice.invoice_id;

        const total = invoice.data.invoice.total;

        const date = invoice.data.invoice.date;

        const paymentPayload = {
          customer_id: customerId,
          payment_mode: "banktransfer",
          amount: total,
          date: date,
          invoice_id: invoiceId,
          amount_applied: total,

          invoices: [
            {
              invoice_id: invoiceId,
              amount_applied: total,
            },
          ],
        };

        payment = await zohoBookApi.post(
          `/customerpayments?organization_id=${org}`,
          paymentPayload,
          {
            headers: {
              authorization: `Zoho-oauthtoken ${accessToken}`,
            },
          },
        );

        console.log("Zoho Payment ID:", payment.data.payment.payment_id);
      } catch (zohoError) {
        /*
         * Razorpay payment has already been successful.
         * Therefore Zoho failure should NOT stop website
         * order creation.
         */

        console.log(
          "Zoho processing failed:",
          zohoError?.response?.data || zohoError.message,
        );

        invoice = null;
        payment = null;
      }
    } else {
      /*
       * No Zoho products in cart.
       * Completely skip Zoho invoice/payment.
       */

      console.log("No Zoho products found. Skipping Zoho invoice/payment.");
    }

    /*
     * =========================================================
     * MEDISHIELD COINS - DEDUCT
     * =========================================================
     */

    const coinsToUse = Number(msc) || 0;

    console.log("MSC FROM FRONTEND:", msc);
    console.log("MSC AFTER NUMBER:", coinsToUse);
    console.log("AVAILABLE COINS:", getAvailableMedishieldCoins(user));

    if (coinsToUse > 0) {
      const availableCoins = getAvailableMedishieldCoins(user);

      console.log("Available Medishield Coins:", availableCoins);

      console.log("Coins Requested:", coinsToUse);

      if (coinsToUse > availableCoins) {
        throw new Error("Insufficient Medishield coins");
      }

      /*
       * Deduct coins from oldest batches first
       */
      await deductMedishieldCoins(user, coinsToUse);
    }

    /*
     * =========================================================
     * CREATE WEBSITE ORDER
     * =========================================================
     */

    let newOrder = await new Order({
      products: userCart.products,

      /*
       * If Zoho invoice/payment was created:
       * save their IDs.
       *
       * Otherwise:
       * save null.
       */

      zohoInvoiceId: invoice?.data?.invoice?.invoice_id || null,

      zohoPaymentId: payment?.data?.payment?.payment_id || null,

      paymentIntent: {
        id: paymentId,
        rzporderId: orderId,
        amount: amount,
        shipping: shipping,
        msc: coinsToUse,
        discount: disc,
        created: Date.now(),
        currency: "INR",
      },

      orderby: user._id,

      couponCodeApplied: couponId ? couponId : null,

      orderStatus: "Processing",

      shippingAddress: shippingAddress,

      couponCode: coupon != null ? coupon.couponCode : null,

      couponDiscount: coupon != null ? coupon.discount : null,

      couponType: coupon != null ? coupon.type : null,
    }).save();

    req.activityTarget = { id: newOrder._id };
    /*
     * =========================================================
     * CREDIT MEDISHIELD COINS FROM PRODUCTS
     * =========================================================
     */

    let prod_msc = 0;

    const promises = userCart.products.map(async (item) => {
      const product = await Product.findById(item.product);

      if (!product) {
        console.log("Product not found:", item.product);

        return;
      }

      if (!product.medishield_coins) {
        console.log("No medisheild coins for this product");
      } else {
        prod_msc += product.medishield_coins * item.count;

        console.log("inner product_msc " + prod_msc);
      }
    });

    await Promise.all(promises);

    console.log("Outer product_msc " + prod_msc);

    /*
     * Add earned coins as a NEW batch
     */

    if (prod_msc > 0) {
      await addMedishieldCoins(user, prod_msc);
    }

    /*
     * =========================================================
     * UPDATE PRODUCT STOCK
     * =========================================================
     */

    let bulkOption = userCart.products.map((item) => {
      return {
        updateOne: {
          filter: {
            _id: item.product.toString(),
          },

          update: {
            $inc: {
              max_sale_qty: -item.count,
            },
          },
        },
      };
    });

    let updated = await Product.bulkWrite(bulkOption, { new: true });

    /*
     * =========================================================
     * SEND EMAIL TO USER
     * =========================================================
     */

    try {
      sendResendEmail(
        (to = user.email),
        (subject = `Order Placed ${newOrder._id}`),
        (html = `<!DOCTYPE html>
        <html lang="en">

        <head>
            <meta charset="UTF-8">
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            >
            <title>Order Confirmation</title>

            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 0;
                    padding: 0;
                    background-color: #f4f4f4;
                }

                .container {
                    max-width: 600px;
                    margin: 20px auto;
                    padding: 20px;
                    background-color: #ffffff;
                    border-radius: 8px;
                    box-shadow:
                      0px 0px 10px rgba(0, 0, 0, 0.1);
                }

                h1 {
                    color: #333333;
                }

                p {
                    color: #666666;
                }

                .order-id {
                    font-weight: bold;
                    color: #007bff;
                }
            </style>
        </head>

        <body>
            <div class="container">
                <h1>Your Order Confirmation</h1>

                <p>Hi,</p>

                <p>
                    Your order has been placed successfully.
                </p>

                <p>
                    Your order ID is:
                    <span class="order-id">
                        ${newOrder._id}
                    </span>
                </p>

                <p>
                    Amount: ${amount} INR
                </p>

                <p>
                    Shipping Address:
                    ${shippingAddress.address},
                    ${shippingAddress.city},
                    ${shippingAddress.state},
                    ${shippingAddress.country} -
                    ${shippingAddress.pincode}
                </p>

                <p>
                    Earned Medishield Coins:
                    ${prod_msc}
                </p>

                <p>
                    You will receive a confirmation email
                    once your items have been shipped.
                </p>

                <p>
                    Thank you for shopping with us!
                </p>
            </div>
        </body>

        </html>
        `),
      );
    } catch (error) {
      return res.json({
        message: "success",
      });
    }

    /*
     * =========================================================
     * SEND EMAIL TO ADMINS
     * =========================================================
     */

    const admins = await User.find({
      role: "admin",
    });

    try {
      admins.forEach((admin) =>
        sendResendEmail(
          (to = admin.email),
          (subject = `New Order Arrived ${newOrder._id}`),
          (html = `<!DOCTYPE html>
          <html lang="en">

          <head>
              <meta charset="UTF-8">
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
              >

              <title>New Order Notification</title>

              <style>
                  body {
                      font-family: Arial, sans-serif;
                      margin: 0;
                      padding: 0;
                      background-color: #f4f4f4;
                  }

                  .container {
                      max-width: 600px;
                      margin: 20px auto;
                      padding: 20px;
                      background-color: #ffffff;
                      border-radius: 8px;
                      box-shadow:
                        0px 0px 10px rgba(0, 0, 0, 0.1);
                  }

                  h1 {
                      color: #333333;
                  }

                  p {
                      color: #666666;
                  }

                  .order-details {
                      margin-top: 20px;
                      padding: 10px;
                      background-color: #f9f9f9;
                      border-radius: 8px;
                  }

                  .order-id,
                  .amount {
                      font-weight: bold;
                      color: #007bff;
                  }
              </style>
          </head>

          <body>
              <div class="container">

                  <h1>New Order Notification</h1>

                  <p>Hi admin,</p>

                  <p>
                      A new order has been placed with
                      the following details:
                  </p>

                  <div class="order-details">

                      <p>
                          <span class="label">
                              Order ID:
                          </span>

                          <span class="order-id">
                              ${newOrder._id}
                          </span>
                      </p>

                      <p>
                          <span class="label">
                              Amount:
                          </span>

                          <span class="amount">
                              ${amount} INR
                          </span>
                      </p>

                      <p>
                          <span class="label">
                              Customer Name:
                          </span>

                          ${shippingAddress.name}
                      </p>

                      <p>
                          <span class="label">
                              Email:
                          </span>

                          ${user.email}
                      </p>

                      <p>
                          <span class="label">
                              Mobile:
                          </span>

                          ${shippingAddress.mobile}
                      </p>

                      <p>
                          <span class="label">
                              Shipping Address:
                          </span>

                          ${shippingAddress.address},
                          ${shippingAddress.city},
                          ${shippingAddress.state},
                          ${shippingAddress.country} -
                          ${shippingAddress.pincode}
                      </p>

                  </div>

                  <p>
                      please check the admin dashboard
                      for more details
                  </p>

              </div>
          </body>

          </html>
          `),
        ),
      );
    } catch (error) {
      return res.json({
        message: "success",
      });
    }

    /*
     * =========================================================
     * FINAL RESPONSE
     * =========================================================
     */

    res.json({
      message: "success",
    });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const cancelOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const order = await Order.findById(id);

    if (order.orderStatus === "Shipped") {
      throw new Error("Order already shipped, cannot be cancelled");
    } else if (order.orderStatus === "Delivered") {
      throw new Error("Order already delivered, cannot be cancelled");
    } else if (order.orderStatus === "Cancelled") {
      throw new Error("Order already cancelled");
    } else {
      // // refund the money to user
      const Razorpay = require("razorpay");
      var instance = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
      instance.payments
        .refund(order.paymentIntent.id, {
          speed: "optimum",
        })
        .then((data) => {
          console.log(data);
        })
        .catch((error) => {
          console.log(error);
        });

      const user = await User.findById(order.orderby);

      if (order.paymentIntent.msc > 0) {
        user.medishieldcoins = Number(
          user.medishieldcoins + order.paymentIntent.msc,
        );
        await user.save();
      }

      // update stock in product
      let bulkOption = order.products.map((item) => {
        return {
          updateOne: {
            filter: { _id: item.product.toString() },
            update: { $inc: { max_sale_qty: item.count } },
          },
        };
      });
      let updated = await Product.bulkWrite(bulkOption, { new: true });

      // debit creddited medishield coins to user
      let prod_msc = 0;
      const promises = order.products.map(async (item) => {
        const product = await Product.findById(item.product);
        if (!product.medishield_coins) {
          console.log("No medishield coins for this product");
        } else {
          prod_msc += product.medishield_coins * item.count;
        }
      });
      await Promise.all(promises);

      user.medishieldcoins = user.medishieldcoins - prod_msc;
      newuser = await user.save();

      // update order status
      order.orderStatus = "Cancelled";
      const updatedOrder = await order.save();

      // send emails to user
      sendResendEmail(
        (to = user.email),
        (subject = `Order Cancelled ${order._id}`),
        (html = `
        <!DOCTYPE html>
        <html lang="en">
  
        <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Cancellation Notification</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        padding: 0;
        background-color: #f4f4f4;
      }
  
      .container {
        max-width: 600px;
        margin: 20px auto;
        padding: 20px;
        background-color: #ffffff;
        border-radius: 8px;
        box-shadow: 0px 0px 10px rgba(0, 0, 0, 0.1);
      }
  
      h1 {
        color: #333333;
      }
  
      p {
        color: #666666;
      }
  
      .order-id {
        font-weight: bold;
        color: #007bff;
      }
    </style>
  </head>
  
  <body>
    <div class="container">
      <h1>Your Order Cancellation</h1>
      <p>Hi,</p>
      <p>This email confirms the cancellation of your order with ID: <span class="order-id">${id}</span>.</p>
      <p>Refund will be initiated to your account within 7-10 business days.</p>
      <p>We understand that circumstances change, and we apologize for any inconvenience this may cause.</p>
      <p>If you have any questions regarding your order cancellation, please don't hesitate to reply to this email or contact our customer service team at <em>eximlko@gmail.com</em> or <em>medishieldhealthcare@gmail.com</em>.</p>
      <p>Thank you for your understanding.</p>
      <p>Sincerely,</p>
      <p><em>MediShield Healthcare PVT. LTD.</em></p>
    </div>
  </body>
  </html>
        `),
      );

      res.json(updatedOrder);
    }
  } catch (error) {
    console.log(error);
    throw new Error("Order cancel error" + error);
  }
});

// get all orders for user
const getOrders = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  validateMongoDbId(_id);
  try {
    const userorders = await Order.find({ orderby: _id })
      .populate("products.product")
      .populate("orderby")
      .populate("couponCodeApplied")
      .exec();
    const userordersinreverse = userorders.reverse();
    res.json({ data: userordersinreverse });
  } catch (error) {
    throw new Error(error);
  }
});

// get all orders for admin
const getAllOrders = asyncHandler(async (req, res) => {
  try {
    const alluserorders = await Order.find()
      .populate("products.product")
      .populate("orderby")
      .populate("couponCodeApplied")
      .exec();
    res.json(alluserorders);
  } catch (error) {
    throw new Error(error);
  }
});

const getCSVforOrders = asyncHandler(async (req, res) => {
  let worker = new Worker("./controller/workers/orderexport.js", {
    workerData: process.env.MONGODB_URL,
  });

  worker.on("message", (message) => {
    const pending = message.previousPendingCSV;
    const today = message.todayPendingCSV;
    // Set response headers
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=orders.csv");
    res
      .status(200)
      .send(
        "Today's Pending Orders\n\n\n" +
          today +
          "\n\n" +
          "Previous Pending Orders\n\n\n" +
          pending,
      );
  });

  worker.on("error", (error) => {
    console.log(error);
    res.status(500).send(error.message);
  });
});

const getMostBoughtProducts = asyncHandler(async (req, res) => {
  try {
    const pipeline = [
      {
        $unwind: "$products",
      },
      {
        $group: {
          _id: "$products.product",
          totalQuantity: { $sum: "$products.count" },
        },
      },
      {
        $lookup: {
          from: "products", // Assuming your products collection name is 'products'
          localField: "_id",
          foreignField: "_id",
          as: "productInfo",
        },
      },
      {
        $unwind: "$productInfo",
      },
      {
        $replaceRoot: { newRoot: "$productInfo" }, // Replace the root document with the productInfo
      },
      {
        $addFields: { totalQuantity: "$totalQuantity" }, // Add the total quantity field
      },
      {
        $sort: { totalQuantity: -1 },
      },
      {
        $limit: 10, // You can adjust this limit based on how many top products you want to fetch
      },
    ];

    const result = await Order.aggregate(pipeline);
    res.json(result);
  } catch (error) {
    throw new Error(error);
  }
});

// get all orders
const getOrderByUserId = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const userorders = await Order.findOne({ orderby: id })
      .populate("products.product")
      .populate("orderby")
      .exec();
    res.json(userorders);
  } catch (error) {
    throw new Error(error);
  }
});

// ship the order and update the status
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, w, l, b, h } = req.body;
  const { id } = req.params;
  validateMongoDbId(id);
  // get order details

  try {
    if (status === "picked") {
      const updatedOrderStatus = await Order.findByIdAndUpdate(
        id,
        {
          orderStatus: "Shipped",
        },
        { new: true },
      )
        .populate("orderby")
        .exec();
      return res.json(updatedOrderStatus);
    }
    if (status !== "Shipped" || !w || !l || !b || !h)
      throw new Error("Weight, length, breadth and height are required");
    else if (status === "Shipped") {
      const apiKey = await ShiprocketAPI.findOne({})
        .sort({ createdAt: -1 })
        .exec();
      const order = await Order.findById(id)
        .populate("products.product")
        .populate("orderby")
        .exec();
      // create payload for shipment
      let updatedOrderStatus = {};
      payload = {
        order_id: order._id.toString(),
        mode: "Surface",
        order_date: new Date().toISOString(),
        billing_customer_name: order.shippingAddress.name,
        billing_last_name: " ",
        billing_address: order.shippingAddress.address,
        billing_city: order.shippingAddress.city,
        billing_state: order.shippingAddress.state,
        billing_country: order.shippingAddress.country,
        billing_pincode: order.shippingAddress.pincode,
        billing_email: order.orderby.email,
        billing_phone: order.shippingAddress.mobile,
        shipping_is_billing: "1",
        order_items: order.products.map((item) => {
          return {
            name: item.product.name,
            sku: item.variant,
            units: item.count,
            selling_price: item.price,
          };
        }),
        payment_method: "prepaid",
        shipping_charges: order.paymentIntent.shipping,
        sub_total: order.paymentIntent.amount - order.paymentIntent.shipping,
        weight: w,
        length: l,
        breadth: b,
        height: h,
        pickup_location: "Primary",
      };
      if (!apiKey) {
        console.log("API key not found or expired");
        // Reauth the API key
        const access_key = await shiprocketLogin();
        // shipment creation
        const response = await createShipment(payload, access_key);

        updatedOrderStatus = await Order.findByIdAndUpdate(
          id,
          {
            orderStatus: status,
            shipmentInfo: response,
          },
          { new: true },
        )
          .populate("orderby")
          .exec();
      } else if (apiKey.expirationDate < new Date()) {
        console.log("API key has expired reauth");
        // Reauth the API key
        const access_key = await shiprocketLogin();
        // shipment creation
        const response = await createShipment(payload, access_key);

        updatedOrderStatus = await Order.findByIdAndUpdate(
          id,
          {
            orderStatus: status,
            shipmentInfo: response,
          },
          { new: true },
        )
          .populate("orderby")
          .exec();
      } else {
        console.log("API key is valid");
        // Make API request using the valid API key
        const response = await createShipment(payload, apiKey.key);

        updatedOrderStatus = await Order.findByIdAndUpdate(
          id,
          {
            orderStatus: status,
            shipmentInfo: response,
          },
          { new: true },
        )
          .populate("orderby")
          .exec();
      }

      sendResendEmail(
        (to = updatedOrderStatus.orderby.email),
        (subject = `Order Status Updated ${updatedOrderStatus._id}`),
        (html = `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Order Update Notification</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 0;
                    background-color: #f5f5f5;
                }
                .container {
                    max-width: 600px;
                    margin: 20px auto;
                    padding: 20px;
                    background-color: #fff;
                    border-radius: 5px;
                    box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
                }
                h1 {
                    color: #333;
                }
                p {
                    margin-bottom: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Order Update Notification</h1>
                <p>Dear Customer,</p>
                <p>We are pleased to inform you that your order with Order ID: <strong>${updatedOrderStatus._id}</strong> has been updated.</p>
                <p><strong>Order Status:</strong> ${status}</p>
                <p><strong>Tracking Number:</strong> ${
                  updatedOrderStatus.shipmentInfo
                    ? updatedOrderStatus.shipmentInfo.payload.awb_code
                    : "N/A"
                }</p>
                <p><strong>courier name:</strong> ${
                  updatedOrderStatus.shipmentInfo
                    ? updatedOrderStatus.shipmentInfo.payload.courier_name
                    : "N/A"
                }</p>
                <p>Thank you for choosing us. Should you have any questions or concerns, please feel free to contact our customer service team.</p>
                <p>Warm regards,</p>
                <p><em>MediShield Healthcare PVT. LTD.</em></p>
            </div>
        </body>
        </html>
        `),
      );

      res.json(updatedOrderStatus);
    }
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

// tracking order webhook
const trackingOrder = asyncHandler(async (req, res) => {
  const { order_id, shipment } = req.body;
  try {
    const order = await Order.findById(order_id);
    order.shipment = shipment;
    await order.save();
    res.json(order);
  } catch (error) {
    throw new Error(error);
  }
});

const getSingleOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const order = await Order.findById(id)
      .populate("products.product")
      .populate("orderby")
      .populate("couponCodeApplied")
      .exec();
    res.json(order);
  } catch (error) {
    throw new Error(error);
  }
});


const updateCartQuantity = asyncHandler(async (req, res) => {
  const { product } = req.body;
  const { _id } = req.user;

  validateMongoDbId(_id);

  if (!product?.variant || !Number.isInteger(product.count)) {
    return res.status(400).json({
      message: "Product variant and valid quantity are required",
    });
  }

  if (product.count < 1) {
    return res.status(400).json({
      message: "Quantity must be at least 1",
    });
  }

  const user = await User.findById(_id);

  if (!user) {
    return res.status(404).json({
      message: "User not found",
    });
  }

  const cart = await Cart.findOne({ orderby: user._id });

  if (!cart) {
    return res.status(404).json({
      message: "Cart not found",
    });
  }

  const cartItem = cart.products.find(
    (item) => String(item.variant) === String(product.variant),
  );

  if (!cartItem) {
    return res.status(404).json({
      message: "Product not found in cart",
    });
  }

  // Check stock for the requested final quantity.
  const { inStock } = await checkStock(
    cartItem.variant,
    product.count,
    cartItem.product,
  );

  if (Number(inStock) < product.count) {
    return res.status(400).json({
      message:
        Number(inStock) <= 0
          ? "This product is currently out of stock"
          : `Only ${inStock} units are available in stock`,
      availableStock: Number(inStock),
    });
  }

  const oldQuantity = Number(cartItem.count || 0);
  const unitPrice = Number(cartItem.price || 0);

  cartItem.count = product.count;

  // Recalculate total from all cart items to avoid total mismatches.
  cart.cartTotal = cart.products.reduce((total, item) => {
    return total + Number(item.price || 0) * Number(item.count || 0);
  }, 0);

  await cart.save();

  const updatedCart = await Cart.findById(cart._id).populate(
    "products.product",
  );

  return res.json(updatedCart);
});

module.exports = {
  createUser,
  loginUserCtrl,
  getAllAdmins,
  updateAdmin,
  getallUser,
  getaUser,
  deleteaUser,
  updatedUser,
  handleRefreshToken,
  logout,
  updatePassword,
  forgotPasswordToken,
  resetPassword,
  loginAdmin,
  getWishlist,
  saveAddress,
  userCart,
  getUserCart,
  emptyCart,
  createOrder,
  getOrders,
  updateOrderStatus,
  getAllOrders,
  getOrderByUserId,
  isEmailVerified,
  sendVerificationEmail,
  verifyEmail,
  loginWithGoogle,
  isUserExists,
  getUser,
  resetPasswordForm,
  removeCartItem,
  getAddresses,
  deleteAddress,
  updateAddress,
  getSingleOrder,
  getMostBoughtProducts,
  createRazorpayOrder,
  cancelOrder,
  getCSVforOrders,
  createAdmin,
  deleteAdmin,
  getUserPermissions,
  googleOAuthLogin,
  appleOAuthLogin,
  updateCartQuantity,
};
