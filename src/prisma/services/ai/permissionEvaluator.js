"use strict";

function normalizePermissionKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9*]/g, "");
}

function activeRoleAssignments(user) {
  return (user?.roleAssignments || []).filter(
    (assignment) => assignment?.isActive && assignment.role?.isActive && !assignment.role?.isDeleted
  );
}

function actionAllowsRead(actions) {
  return ["read", "create", "update", "delete", "approve", "submit", "release", "export"].some(
    (item) => actions.includes(item)
  );
}

function rolePermissionMatches(permission, requirement, pageContext) {
  if (permission?.isActive === false || permission?.isDeleted === true) return false;
  const requiredAction = String(requirement.action || "read").toLowerCase();
  const targetResource = normalizePermissionKey(requirement.resourceCode || requirement.resource);
  const contextModule = normalizePermissionKey(pageContext?.moduleCode || requirement.moduleCode);
  const contextPage = normalizePermissionKey(pageContext?.pageCode || requirement.pageCode);
  const permissionModule = normalizePermissionKey(permission.moduleCode);
  const permissionPage = normalizePermissionKey(permission.pageCode);
  const permissionResource = normalizePermissionKey(permission.resourceCode);
  const targets = [permission.resourceCode, permission.pageCode, permission.moduleCode].map(normalizePermissionKey);
  const moduleMatch = permissionModule === "*" || permissionModule === contextModule;
  const pageMatch = permissionPage === "*" || permissionPage === contextPage;
  const resourceMatch = permissionResource === "*" || permissionResource === targetResource;
  const explicitlyGlobal = permissionModule === "*" && permissionPage === "*" && permissionResource === "*";
  const legacyMatch = explicitlyGlobal || (permissionResource !== "*" && targets.includes(targetResource));
  if (!(moduleMatch && pageMatch && resourceMatch) && !legacyMatch) return false;
  const actions = Array.isArray(permission.actions)
    ? permission.actions.map((item) => String(item).toLowerCase())
    : [];
  if (actions.includes("*")) return true;
  return requiredAction === "read" ? actionAllowsRead(actions) : actions.includes(requiredAction);
}

function legacyMenuMatches(entry, requirement) {
  if (!entry || typeof entry !== "object" || !entry.resource) return false;
  const requiredAction = String(requirement.action || "read").toLowerCase();
  const targetResource = normalizePermissionKey(requirement.resourceCode || requirement.resource);
  if (normalizePermissionKey(entry.resource) !== targetResource) return false;
  const actions = Array.isArray(entry.actions)
    ? entry.actions.map((item) => String(item).toLowerCase())
    : [];
  if (actions.includes("*")) return true;
  if (!actions.length && requiredAction === "read") return true;
  if (requiredAction === "read") {
    return ["read", "create", "update", "delete", "approve"].some((item) => actions.includes(item));
  }
  return actions.includes(requiredAction);
}

function userHasPermission(user, requirement = {}, pageContext = {}) {
  if (!user) return false;
  if (user.isSuperAdmin === true) return true;
  const assignments = activeRoleAssignments(user);
  if (assignments.length) {
    return assignments.some((assignment) =>
      (assignment.role.permissions || []).some((permission) =>
        rolePermissionMatches(permission, requirement, pageContext)
      )
    );
  }
  return (Array.isArray(user.listMenu) ? user.listMenu : []).some((entry) =>
    legacyMenuMatches(entry, requirement)
  );
}

module.exports = {
  normalizePermissionKey,
  activeRoleAssignments,
  rolePermissionMatches,
  legacyMenuMatches,
  userHasPermission,
};
