import { TestDatabaseManager } from './tests/helpers/database.js';

async function testDb() {
  const db = new TestDatabaseManager();
  await db.setup();

  // Try to check what tables exist
  const tables = await db.executeRaw(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
  `);
  console.log('Tables:', tables);

  // Check communities
  try {
    const communities = await db.executeRaw(
      'SELECT * FROM communities LIMIT 5'
    );
    console.log('Communities:', communities);
  } catch (err) {
    console.log('Communities error:', err.message);
  }

  // Check stories
  try {
    const stories = await db.executeRaw('SELECT * FROM stories LIMIT 5');
    console.log('Stories:', stories);
  } catch (err) {
    console.log('Stories error:', err.message);
  }

  await db.teardown();
}

testDb().catch(console.error);
