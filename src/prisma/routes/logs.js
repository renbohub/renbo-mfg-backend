const router = require('express').Router();
const ctrl = require('../controllers/LogController');
const { authorize } = require('../middleware/auth');

// List logs dengan filtering
router.get('/', authorize('logs', 'read'), ctrl.list);

// Get statistics/summary
router.get('/stats', authorize('logs', 'read'), ctrl.stats);

// Get user activities
router.get('/user-activities', authorize('logs', 'read'), ctrl.userActivities);

// Get single log detail
router.get('/:id', authorize('logs', 'read'), ctrl.get);

// Cleanup old logs (hanya admin)
router.post('/cleanup', authorize('logs', 'delete'), ctrl.cleanup);

// Export to CSV (future feature)
router.get('/export/csv', authorize('logs', 'read'), ctrl.exportCsv);

module.exports = router;
