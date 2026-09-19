// Synthetic member data for the CU Console mock app.
//
// SPEC §0.4: no real PII, ever. Every name below is obviously fake.
// Do not add real names, SSNs, or account numbers here.

export interface SubAccount {
  accountNumber: string;
  accountType: string;
  balance: number;
  openedAt: string; // ISO date
}

export interface Member {
  id: string;
  name: string;
  memberSince: string; // ISO date, e.g. "2015-03-12"
  restricted: boolean; // true => permission-denied on lookup
  savings: number;
  checking: number;
  subAccounts: SubAccount[];
}

/** Minimum initial deposit required to open a sub-account. Anything below this
 * is a validation error (business outcome), not a crash. */
export const MIN_DEPOSIT = 25.0;

/** In-memory member table. IDs 10001..10008. Member 10007 is restricted. */
export const members: Map<string, Member> = new Map(
  (
    [
      { id: "10001", name: "Testy McTestface", memberSince: "2015-03-12", savings: 4200, checking: 1100 },
      { id: "10002", name: "Ann Onymous", memberSince: "2017-07-01", savings: 900, checking: 250 },
      { id: "10003", name: "Sam Placeholder", memberSince: "2012-11-20", savings: 15000, checking: 3000 },
      { id: "10004", name: "Fictional Person", memberSince: "2019-02-14", savings: 500, checking: 500 },
      { id: "10005", name: "Jane Q. Sample", memberSince: "2020-09-30", savings: 8800, checking: 1200 },
      { id: "10006", name: "Mock Userington", memberSince: "2021-05-05", savings: 2200, checking: 400 },
      {
        id: "10007",
        name: "Restricted Rachel",
        memberSince: "2016-01-10",
        savings: 0,
        checking: 0,
        restricted: true,
      },
      { id: "10008", name: "Faux Newperson", memberSince: "2022-08-22", savings: 3300, checking: 900 },
    ] as Array<Partial<Member> & Pick<Member, "id" | "name" | "memberSince" | "savings" | "checking">>
  ).map((m) => [
    m.id,
    {
      id: m.id,
      name: m.name,
      memberSince: m.memberSince,
      restricted: m.restricted ?? false,
      savings: m.savings,
      checking: m.checking,
      subAccounts: [],
    },
  ])
);

/** Look up a member by exact ID. Returns undefined if the ID isn't in the table. */
export function findMemberById(id: string): Member | undefined {
  return members.get(id);
}

/** Case-insensitive substring search across id and name. Empty query matches everyone
 * (used to demonstrate a multi-row results table). */
export function searchMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  const all = Array.from(members.values());
  if (q === "") return all;
  if (/^\d+$/.test(q)) {
    const hit = members.get(q);
    return hit ? [hit] : [];
  }
  return all.filter((m) => m.name.toLowerCase().includes(q));
}

/** "Opens" a sub-account in-memory (no persistence beyond process lifetime). */
export function openSubAccount(memberId: string, accountType: string, initialDeposit: number): SubAccount {
  const member = members.get(memberId);
  if (!member) throw new Error(`unknown member ${memberId}`);
  const accountNumber = `SA-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 900 + 100)}`;
  const subAccount: SubAccount = {
    accountNumber,
    accountType,
    balance: initialDeposit,
    openedAt: new Date().toISOString().slice(0, 10),
  };
  member.subAccounts.push(subAccount);
  return subAccount;
}
