// backend/services/modeSelector.js

class ModeSelector {
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