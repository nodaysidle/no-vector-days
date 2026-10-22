/**
 * History & Undo/Redo Engine
 * Transactional command stack for canvas mutations.
 */

export class History {
  constructor(limit = 50) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }
    this.redoStack = []; // Clear forward history on new action
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    const cmd = this.undoStack.pop();
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    const cmd = this.redoStack.pop();
    cmd.redo();
    this.undoStack.push(cmd);
    return true;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
