const router = require("express").Router();
const controller = require("../../controllers/dashboard/ExecutiveDashboardController");
const { authorize } = require("../../middleware/auth");
router.get("/sales/customers", authorize("salesOrder", "read"), async (req, res, next) => {
  try {
    const { prisma } = require("../../index");
    res.json(await prisma.customer.findMany({ where: { isDeleted: false }, select: { customerCode: true, customerName: true }, orderBy: { customerCode: "asc" } }));
  } catch (error) { next(error); }
});

router.get("/:module", require("../../services/dashboardAccess").dashboardAccess, controller.get);

module.exports = router;
