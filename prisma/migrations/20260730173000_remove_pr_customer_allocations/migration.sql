-- Customer allocation was introduced from a misunderstood requirement.
-- Purchasing demand is split by supplier through
-- tbl_purchase_requisition_sourcing_allocation instead.
DROP TABLE IF EXISTS "tbl_purchase_requisition_demand_allocation";
