// TODO: move to Supabase tables (reminders, todos) for persistence across restarts.
const reminders = new Map();
const todos = new Map();

function addReminder(userId, text, dueAt) {
  if (!reminders.has(userId)) reminders.set(userId, []);
  const reminder = { id: Date.now().toString(), text, dueAt };
  reminders.get(userId).push(reminder);
  return reminder;
}

function getDueReminders(userId) {
  const now = Date.now();
  return (reminders.get(userId) || []).filter((r) => new Date(r.dueAt).getTime() <= now);
}

function addTodo(userId, text) {
  if (!todos.has(userId)) todos.set(userId, []);
  const todo = { id: Date.now().toString(), text, done: false };
  todos.get(userId).push(todo);
  return todo;
}

function completeTodo(userId, todoId) {
  const list = todos.get(userId) || [];
  const todo = list.find((t) => t.id === todoId);
  if (todo) todo.done = true;
  return todo;
}

function getTodos(userId, includeDone = false) {
  const list = todos.get(userId) || [];
  return includeDone ? list : list.filter((t) => !t.done);
}

async function getDailyBriefing(userId) {
  const dueReminders = getDueReminders(userId);
  const pendingTodos = getTodos(userId);
  return {
    reminders: dueReminders,
    todos: pendingTodos,
    summary: `Aaj ${dueReminders.length} reminders aur ${pendingTodos.length} pending todos hain.`
  };
}

module.exports = { addReminder, getDueReminders, addTodo, completeTodo, getTodos, getDailyBriefing };
