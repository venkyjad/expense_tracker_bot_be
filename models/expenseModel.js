const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

exports.createExpense = async (expense) => {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('expenses')
    .insert([
      {
        id: crypto.randomUUID(),
        ...expense,
        created_at: now,
        updated_at: now
      }
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
};

exports.getExpensesByUser = async (userId) => {
  const { data, error } = await supabase
    .from('expenses')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  if (error) throw error;
  return data;
}; 