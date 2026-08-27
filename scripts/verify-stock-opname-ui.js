"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const form = read("frontend/views/inventory/form.ejs");
assert(form.includes('id="countMode"'), "Stock Opname form must expose Full/Cycle mode");
assert(form.includes('id="stockType" multiple'), "Stock type scope must support multiple selection");
assert(form.includes("WIP / WP / Semi-Finished"), "WIP scope must visibly include WP");
assert(form.includes('id="sto-preview-scope"'), "Scope preview action missing");
assert(form.includes('id="toleranceQty"') && form.includes('id="tolerancePercent"'), "Tolerance controls missing");

const formScript = read("frontend/public/js/inventory-form.js");
assert(formScript.includes("/stock-opname/preview"), "Scope preview API integration missing");
assert(formScript.includes("stockTypes: selectedValues"), "Multiple stock types not included in payload");
assert(formScript.includes("rackCodes: selectedValues"), "Multiple rack codes not included in payload");

const countView = read("frontend/views/inventory/stock-opname-count.ejs");
const countScript = read("frontend/public/js/stock-opname-count.js");
assert(countView.includes('id="sto-found-form"'), "Found Stock form missing");
assert(countView.includes('id="sto-member-name"'), "Member name must be entered once for the count session");
assert(countView.includes('id="sto-start-session"'), "Multi-member session activation missing");
assert(countView.includes('data-count-filter="UNCOUNTED"'), "Uncounted-item member filter missing");
assert(countView.includes('id="sto-member-roster"'), "Member contribution roster missing");
assert(countView.includes('id="sto-count-rows"'), "Inline physical-count matrix missing");
assert(countView.includes('data-enterprise-table="off"'), "Member count matrix must stay simple without enterprise table controls");
assert(countScript.includes("/found-stock"), "Found Stock API integration missing");
assert(countScript.includes("/bulk-count"), "Inline partial-save integration missing");
assert(countScript.includes("state.dirty"), "Only changed count rows should be submitted");
assert(countScript.includes("ownedByOther"), "Rows counted by another member must be locked in the UI");
assert(countScript.includes("sessionStorage.setItem(sessionKey"), "Member session must survive refresh");
assert(countScript.includes("WAITING_CHECK"), "Counting page must understand WAITING_CHECK");

const operations = read("frontend/public/js/operations-detail.js");
assert(operations.includes('status === "waiting-check"'), "Checker state action missing");
assert(operations.includes('actionButton("check"'), "Checker action missing");
assert(operations.includes("/adjust-preview"), "Adjustment conflict preview missing");

console.log("Balanced Stock Opname UI contract checks passed");
