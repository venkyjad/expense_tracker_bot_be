const expenseModel = require('../models/expenseModel');
const userModel = require('../models/userModel');

exports.createExpense = async (req, res) => {
  try {
    const expense = await expenseModel.createExpense(req.body);
    res.status(201).json(expense);
  } catch (error) {
    console.error('Error saving expense:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getUserExpenses = async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await userModel.getUserByPhone(phone);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const expenses = await expenseModel.getExpensesByUser(user.id);
    res.json(expenses);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}; 