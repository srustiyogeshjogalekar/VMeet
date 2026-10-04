import { apiUrl } from "./socket";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl}/api/auth${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new Error("Cannot reach the account service. Make sure the backend is running.");
  }

  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Account request failed.");
  return result;
}

export function registerAccount({ name, email, password }) {
  return request("/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
}

export function loginAccount({ email, password }) {
  return request("/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function getCurrentUser() {
  return request("/me");
}

export function logoutAccount() {
  return request("/logout", { method: "POST" });
}
