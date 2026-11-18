// A question to a chosen agent (AO-0063): a task of type `question` owned by that agent. Only it
// sees the question in its queue; swarmupd wakes it with the question and the tasks it references,
// and its answer (`swarmup done ID "answer"`) comes back to the asker's inbox. Agents ask agents this
// way; a person talks with the PM in Chat instead (AO-0134), and New task still offers the type.
// `swarmup ask` is the other way round: an agent working a task asks a person, and the task blocks
// until the answer.

/** The task type of a question. */
export const QUESTION = 'question';
