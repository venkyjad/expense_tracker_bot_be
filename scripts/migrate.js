const { execSync } = require('child_process');
const path = require('path');

async function runMigrations() {
  try {
    console.log('Running database migrations...');
    
    // Generate Prisma Client
    console.log('Generating Prisma Client...');
    execSync('npx prisma generate', { stdio: 'inherit' });

    // Run migrations
    console.log('Applying migrations...');
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });

    console.log('Migrations completed successfully!');
  } catch (error) {
    console.error('Error running migrations:', error);
    process.exit(1);
  }
}

runMigrations(); 