const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');

router.post('/expense', expenseController.createExpense);
router.get('/user/:phone/expenses', expenseController.getUserExpenses);

module.exports = router; 