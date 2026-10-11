import { expect, test } from "bun:test";
import { vapidSubject } from "./push";

test("VAPID subject: the override, else mailto the first allowed login, else the placeholder", () => {
  expect(vapidSubject({ TERN_MOBILE_VAPID_SUBJECT: "https://example.test" }, ["a@b.test"])).toBe("https://example.test");
  expect(vapidSubject({}, ["me@example.test", "other@example.test"])).toBe("mailto:me@example.test");
  expect(vapidSubject({ TERN_MOBILE_VAPID_SUBJECT: "" }, ["tagged-device"])).toBe("https://tern-mobile.invalid");
  expect(vapidSubject({}, [])).toBe("https://tern-mobile.invalid");
});
