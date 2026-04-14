export const SKILL_FAMILIES: Record<string, string[]> = {
  frontend: ["react", "angular", "vue"],
  backend: ["nodejs", "spring", "django", "express"],
  cloud: ["aws", "gcp", "azure"],
  ml: ["machine_learning", "deep_learning", "tensorflow", "pytorch"],
  data: ["sql", "postgres", "mongodb"],
};

export function getSkillFamily(skill: string): string | null {
  const normalizedSkill = skill.trim().toLowerCase();
  for (const [family, skills] of Object.entries(SKILL_FAMILIES)) {
    if (skills.includes(normalizedSkill)) return family;
  }
  return null;
}

export function getSkillMatchScore(jobSkill: string, userSkills: string[]): number {
  const normalizedJobSkill = jobSkill.trim().toLowerCase();
  const normalizedUserSkills = userSkills.map((skill) => skill.trim().toLowerCase());

  if (normalizedUserSkills.includes(normalizedJobSkill)) return 1.0;

  const jobFamily = getSkillFamily(normalizedJobSkill);

  if (!jobFamily) return 0;

  for (const userSkill of normalizedUserSkills) {
    if (getSkillFamily(userSkill) === jobFamily) {
      return 0.6;
    }
  }

  return 0;
}
