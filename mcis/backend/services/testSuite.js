const logger = require('./logger');
const { EVENT_TYPES } = require('./eventService');

// Test all event types
async function testEventDetection(detectEvents) {
  const testCases = [
    { message: 'Completed 10 DSA problems', expected: 'goal_progress' },
    { message: 'I am confused with DP', expected: 'learning_gap' },
    { message: 'I nailed the graphs', expected: 'skill_mastered' },
    { message: 'Exam deadline is tomorrow', expected: 'deadline_approaching' },
    { message: 'I prefer class-based solutions', expected: 'preference_detected' }
  ];

  const results = [];
  for (const test of testCases) {
    const events = detectEvents(test.message, 0);
    const passed = events.some(e => e.type === test.expected);
    results.push({
      test: test.message,
      expected: test.expected,
      passed,
      detected: events.map(e => e.type)
    });
  }

  logger.info('Event Detection Tests:', results);
  return results;
}

// Test notification creation
async function testNotificationCreation(supabase) {
  try {
    const testNotif = {
      user_id: 'test-user-123',
      message: 'Test notification',
      type: 'test',
      read: false,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('notifications')
      .insert([testNotif]);

    if (error) throw error;
    logger.info('✅ Notification creation test: PASSED');
    return true;
  } catch (err) {
    logger.error('❌ Notification creation test: FAILED', err.message);
    return false;
  }
}

// Test event trigger execution
async function testEventTriggers(processEventTriggers) {
  try {
    const testEvents = [
      {
        event_type: 'learning_gap',
        data: { topic: 'DP' }
      }
    ];

    const result = await processEventTriggers('test-user-123', testEvents);
    logger.info('✅ Event trigger test: PASSED', result);
    return true;
  } catch (err) {
    logger.error('❌ Event trigger test: FAILED', err.message);
    return false;
  }
}

// Run all tests
async function runAllTests(supabase, detectEvents, processEventTriggers) {
  logger.info('=== RUNNING TEST SUITE ===');
  
  const results = {
    eventDetection: testEventDetection(detectEvents),
    notificationCreation: await testNotificationCreation(supabase),
    eventTriggers: await testEventTriggers(processEventTriggers)
  };

  logger.info('=== TEST SUITE COMPLETE ===');
  return results;
}

module.exports = {
  testEventDetection,
  testNotificationCreation,
  testEventTriggers,
  runAllTests
};