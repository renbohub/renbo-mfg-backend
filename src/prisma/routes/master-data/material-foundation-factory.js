const { authorize } = require("../../middleware/auth");
const { logger } = require("../../middleware/logger");

module.exports = function materialFoundationRouter(handlers, auditEntity) {
  const router = require("express").Router();
  router.get("/autocomplete", authorize("materials", "read"), handlers.autocomplete);
  router.get("/", authorize("materials", "read"), handlers.list);
  router.get("/:key", authorize("materials", "read"), handlers.get);
  router.post("/", authorize("materials", "create"), logger(auditEntity, "create"), handlers.create);
  router.patch("/:id", authorize("materials", "update"), logger(auditEntity, "update"), handlers.update);
  router.patch("/:id/remove", authorize("materials", "delete"), logger(auditEntity, "delete"), handlers.remove);
  return router;
};
