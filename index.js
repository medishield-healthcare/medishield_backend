const bodyParser = require("body-parser");
const express = require("express");
const dbConnect = require("./config/dbConnect");
const { notFound, errorHandler } = require("./middlewares/errorHandler");
const app = express();
const dotenv = require("dotenv").config();
const PORT = 5000;


const authRouter = require("./routes/authRoute");
const productRouter = require("./routes/productRoute");

const categoryRouter = require("./routes/prodcategoryRoute");

const brandRouter = require("./routes/brandRoute");
const cartRouter = require("./routes/cartRoute");

const enqRouter = require("./routes/enqRoute");
const roleRouter = require("./routes/permissionRoute");
const uploadRouter = require("./routes/uploadRoute");
const couponRouter = require("./routes/couponRoute");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const cors = require("cors");

dbConnect();
app.use(morgan("dev"));

app.use(cors());
app.use(bodyParser.json({
  limit: "50mb",
  extended: true,
  parameterLimit: 50000,
}));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/api/user", authRouter);
app.use("/api/product", productRouter);
app.use("/api/category", categoryRouter);
app.use("/api/brand", brandRouter);
app.use("/api/enquiry", enqRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/cart", cartRouter);
app.use("/api/roles", roleRouter);
app.use("/api/coupon", couponRouter)

app.get("/health", (req, res) => {
  res.status(200).json({ message: "Everything is healthy" });
});

app.use(notFound);
app.use(errorHandler);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running  at PORT ${PORT}`);
});
