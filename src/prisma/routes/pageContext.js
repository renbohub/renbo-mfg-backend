const router = require("express").Router();
const controller = require("../controllers/PageContextController");

router.get("/", controller.list);
router.get("/overview", controller.overview);
router.post("/comments", controller.createComment);
router.post("/errors", controller.reportClientError);

module.exports = router;
