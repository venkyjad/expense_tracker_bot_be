const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

exports.getUserByPhone = async (phone) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single();
  if (error || !data) return null;
  return data;
};

exports.createUser = async ({ phone, name, email }) => {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('users')
    .insert([
      {
        id: crypto.randomUUID(),
        phone,
        name,
        email,
        company_id: 'default',
        created_at: now,
        updated_at: now
      }
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Example: getOrCreateUser, getUserByPhone, createUser, etc. 