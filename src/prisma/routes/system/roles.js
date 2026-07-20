const router = require("express").Router();
const controller = require("../../controllers/system/RoleController");
const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

router.get("/users", authorize("roles-permissions", "read"), controller.users);
router.get("/", authorize("roles-permissions", "read"), controller.list);
router.get("/:id", authorize("roles-permissions", "read"), controller.get);
router.post("/", authorize("roles-permissions", "create"), logger("roles-permissions", "create"), controller.create);
router.patch("/:id", authorize("roles-permissions", "update"), logger("roles-permissions", "update", { modelName: "role" }), controller.update);
router.patch("/:id/remove", authorize("roles-permissions", "delete"), logger("roles-permissions", "delete", { modelName: "role" }), controller.remove);

module.exports = router;
