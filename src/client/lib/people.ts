/** How a person is shown wherever a record only stores who did something.
 *
 * A column of full addresses is unreadable, and a column of full names is
 * wider than the data deserves, so the By columns show "J. Tong": the initial
 * of the recorded first name, then the surname.
 *
 * The name in the users table is the only reliable source. Sign-in addresses
 * happen to be first initial plus surname today, but nothing enforces that,
 * and a shared mailbox like accounts@ would come out as "A. Ccounts" if we
 * took the address apart. So the fallback only tidies — it never splits a
 * name it was not given. Anyone showing as a bare address needs a name in
 * Admin → Users.
 */
export function displayPerson(name: string | null | undefined, email: string | null | undefined): string {
  const full = (name ?? "").trim();
  return full ? abbreviate(full) : personName(email);
}

/** "Jennifer Tong" → "J. Tong". A single-word name is left alone, so a shared
 *  account named "Accounts" stays "Accounts". */
function abbreviate(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  return `${parts[0][0].toUpperCase()}. ${parts[parts.length - 1]}`;
}

/** Address to something readable: sarah.jones@… → "Sarah Jones", accounts@… →
 *  "Accounts". A value that is already a name is passed through untouched. */
export function personName(who: string | null | undefined): string {
  const raw = (who ?? "").trim();
  if (!raw || !raw.includes("@")) return raw;

  const parts = (raw.split("@")[0] ?? "").split(/[._-]+/).filter(Boolean);
  return parts.length ? parts.map(cap).join(" ") : raw;
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}
