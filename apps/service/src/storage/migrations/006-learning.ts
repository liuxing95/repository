export const learning = `
CREATE TABLE learning_goals (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE learning_baselines (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES learning_goals(id), value TEXT NOT NULL);
CREATE TABLE learning_choices (goal_id TEXT NOT NULL, unit_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(goal_id,unit_id));
CREATE TABLE learning_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, unit_id TEXT NOT NULL, baseline_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE learning_evaluations (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES learning_attempts(id), value TEXT NOT NULL);
CREATE TABLE learning_suggestions (id TEXT PRIMARY KEY, suggestion_key TEXT NOT NULL UNIQUE, goal_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE learning_task_intents (id TEXT PRIMARY KEY, suggestion_id TEXT NOT NULL UNIQUE REFERENCES learning_suggestions(id), value TEXT NOT NULL);
CREATE TABLE learning_operations (key TEXT PRIMARY KEY, digest TEXT NOT NULL, result_id TEXT NOT NULL);
PRAGMA user_version = 6;
`;
