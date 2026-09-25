const r = require('express').Router();
const mongoose = require('mongoose');

const AdminNotification = require('../models/AdminNotification');
const auth = require('../middleware/auth');

/* -------------------------------------------------------
   GET ADMIN NOTIFICATIONS
------------------------------------------------------- */

r.get(
  '/',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      const notifications =
        await AdminNotification.find()
          .populate('order')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();

      return res.json(notifications);

    } catch (error) {
      console.error(
        '[NOTIFICATIONS GET ERROR]',
        error.message
      );

      return res.status(500).json({
        message: 'Unable to load notifications.'
      });
    }
  }
);

/* -------------------------------------------------------
   MARK NOTIFICATION AS READ
   ADMIN ONLY
------------------------------------------------------- */

r.patch(
  '/:id/read',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      if (
        !mongoose.Types.ObjectId.isValid(
          req.params.id
        )
      ) {
        return res.status(400).json({
          message: 'Invalid notification ID.'
        });
      }

      const notification =
        await AdminNotification.findByIdAndUpdate(
          req.params.id,
          {
            $set: {
              read: true
            }
          },
          {
            new: true,
            runValidators: true
          }
        ).lean();

      if (!notification) {
        return res.status(404).json({
          message: 'Notification not found.'
        });
      }

      return res.json(notification);

    } catch (error) {
      console.error(
        '[NOTIFICATION READ ERROR]',
        error.message
      );

      return res.status(500).json({
        message: 'Unable to update notification.'
      });
    }
  }
);

module.exports = r;