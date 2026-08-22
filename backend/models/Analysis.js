import mongoose from 'mongoose';

const AnalysisSchema = new mongoose.Schema({
  videoId: {
    type: String,
    required: true,
    index: true
  },
  url: {
    type: String,
    required: true
  },
  claims: [String],
  results: [{
    claim: String,
    evidence: [{
      title: String,
      snippet: String,
      url: String
    }],
    timestamp: String,
    importance: String,
    agentic: Boolean,
    verdict: String,
    confidence: Number,
    reasoning: String,
    supporting_sources: [Number]
  }],
  overallScore: Number,
  summary: String,
  analyzedAt: {
    type: Date,
    default: Date.now
  },
  meta: {
    scoringModel: String,
    llmProvider: String,
    claimMetadata: [mongoose.Schema.Types.Mixed]
  }
});

export default mongoose.model('Analysis', AnalysisSchema);
