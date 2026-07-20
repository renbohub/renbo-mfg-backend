const router = require("express").Router();
const ctrl = require("../controllers/AuthController");
const { auth, authorize } = require("../middleware/auth");

const isProduction = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

if (isProduction) {
  router.post("/register", auth, authorize("users", "create"), ctrl.register); // production || prod
} else {
  router.post("/register", ctrl.register); // development || dev
}

router.post("/login", ctrl.login);

module.exports = router;
