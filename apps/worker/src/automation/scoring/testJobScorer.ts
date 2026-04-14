import { scoreJob } from "./jobScorer.js";

function run() {
  const strong = scoreJob({
    jobProfile: {
      role: "Senior Frontend Engineer",
      skills: ["typescript", "react", "graphql", "testing"],
      keywords: ["design systems", "performance", "accessibility"],
      seniority: "senior"
    },
    userProfile: {
      skills: ["typescript", "react", "graphql", "testing", "accessibility"],
      yearsExperience: 7,
      resumeText: "Built and scaled frontend architecture with performance optimization."
    },
    jobDescription: "Senior frontend role requiring TypeScript, React, GraphQL, and performance focus."
  });

  const medium = scoreJob({
    jobProfile: {
      role: "Frontend Engineer",
      skills: ["typescript", "react", "node"],
      keywords: ["ci/cd", "graphql", "monitoring"],
      seniority: "mid"
    },
    userProfile: {
      skills: ["typescript", "react"],
      yearsExperience: 3,
      resumeText: "Frontend and UI engineering experience."
    },
    jobDescription: "Mid frontend role with modern web stack and APIs."
  });

  const weak = scoreJob({
    jobProfile: {
      role: "Senior Data Engineer",
      skills: ["spark", "kafka", "python", "airflow"],
      keywords: ["etl", "streaming", "warehouse"],
      seniority: "senior"
    },
    userProfile: {
      skills: ["react", "typescript"],
      yearsExperience: 1,
      resumeText: "Built dashboards and frontend features."
    },
    jobDescription: "Senior data engineering role with Spark, Kafka and ETL pipelines."
  });

  console.log("[JobScorer] strong:", strong);
  console.log("[JobScorer] medium:", medium);
  console.log("[JobScorer] weak:", weak);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
