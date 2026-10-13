// backend/services/modeSelector.js
//
// NOTE: this used to reference this.getUserProfile()/this.analyzeGoal()
// without defining them anywhere — any call to selectMode() would throw
// "getUserProfile is not a function". Added lightweight implementations
// below so the class is actually callable. There's no dedicated
// "learning preferences" table yet, so getUserProfile falls back to a
// small in-memory default; swap this for a real DB lookup (e.g. Supabase
// `user_profiles`) when that table exists.

class ModeSelector {
  constructor() {
    this._profileCache = new Map();
  }

  async getUserProfile(userId) {
    if (this._profileCache.has(userId)) return this._profileCache.get(userId);
    // Sensible default: no explicit learning goal, no time pressure ->
    // HYBRID mode (do the work, teach along the way when it's cheap to).
    const profile = { learningGoal: false, timePressure: false };
    this._profileCache.set(userId, profile);
    return profile;
  }

  setUserProfile(userId, profile) {
    this._profileCache.set(userId, { ...(this._profileCache.get(userId) || {}), ...profile });
  }

  async analyzeGoal(goal) {
    const text = String(goal || '');
    // Very rough heuristic: longer / multi-clause goals take longer.
    const clauses = text.split(/,| and | phir | uske baad /i).length;
    const timeEstimate = Math.min(60, Math.max(5, clauses * 6 + Math.round(text.length / 20)));
    return { timeEstimate, clauses };
  }

  async selectMode(userId, goal) {
    const userProfile = await this.getUserProfile(userId);
    const goalAnalysis = await this.analyzeGoal(goal);

    // Logic:
    // - If user has TIME + wants to LEARN → LEARN mode
    // - If user is TIME-PRESSED → EXECUTE mode
    // - If user wants BOTH → HYBRID mode

    if (userProfile.learningGoal && goalAnalysis.timeEstimate > 20) {
      return 'LEARN'; // Socratic questions
    } else if (userProfile.timePressure) {
      return 'EXECUTE'; // Just do it
    } else {
      return 'HYBRID'; // Do + teach
    }
  }
}

// Was missing entirely before — meant `require('./modeSelector')` returned
// an empty object and any usage crashed with "selectMode is not a function".
module.exports = new ModeSelector();