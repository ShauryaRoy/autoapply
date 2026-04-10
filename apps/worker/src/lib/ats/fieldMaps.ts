export interface FieldMapPack {
  provider: string;
  version: string;
  fields: Record<string, string[]>;
}

export const workdayFieldMap: FieldMapPack = {
  provider: "workday",
  version: "2026.04",
  fields: {
    firstName: ["input[name='firstName']", "[data-automation-id='firstName'] input"],
    lastName: ["input[name='lastName']", "[data-automation-id='lastName'] input"],
    email: ["input[name='email']", "[data-automation-id='email'] input"],
    phone: ["input[name='phone']", "[data-automation-id='phone'] input"]
  }
};

export const greenhouseFieldMap: FieldMapPack = {
  provider: "greenhouse",
  version: "2026.04",
  fields: {
    firstName: ["#first_name", "input[name='first_name']"],
    lastName: ["#last_name", "input[name='last_name']"],
    email: ["#email", "input[name='email']"],
    phone: ["#phone", "input[name='phone']"]
  }
};

export const genericFieldMap: FieldMapPack = {
  provider: "generic",
  version: "2026.04",
  fields: {
    firstName: [
      "input[name='first_name']", "input[name='firstName']",
      "input[id*='first']", "input[placeholder*='First']"
    ],
    lastName: [
      "input[name='last_name']", "input[name='lastName']",
      "input[id*='last']", "input[placeholder*='Last']"
    ],
    email: [
      "input[name='email']", "input[type='email']",
      "input[id*='email']", "input[placeholder*='Email']"
    ],
    phone: [
      "input[name='phone']", "input[type='tel']",
      "input[id*='phone']", "input[placeholder*='Phone']"
    ]
  }
};
