// Archetypes (who the tester plays) and playbooks (drejebøger) for this app. Write your own for your fork's
// customers: each archetype has a ring (what that customer sees) and each playbook a page to start on and tasks.
// A session keeps a copy of the text, so changing this file never changes old sessions.

export type Archetype = {
  key: string;
  name: string;
  who: string;
  wants: string;
  worries: string;
  /** The ring this customer sees the app as. 4 = only what is stable. */
  ring: number;
};

export type Playbook = {
  key: string;
  archetype: string;
  title: string;
  start: string;
  tasks: { id: string; title: string }[];
};

export const ARCHETYPES: Archetype[] = [
  {
    key: "ny-bruger",
    name: "Lone, ny bruger",
    who: "Har fået et link fra en kollega og logger ind for første gang.",
    wants: "Forstå hvad appen kan, og komme i gang uden hjælp.",
    worries: "At hun gør noget forkert eller deler noget, hun ikke ville.",
    ring: 4,
  },
  {
    key: "travl-medarbejder",
    name: "Kasper, travl medarbejder",
    who: "Bruger appen dagligt på telefonen og i browseren.",
    wants: "Gemme et link eller en tekst på få sekunder og finde den igen.",
    worries: "At det tager for mange klik, eller at klip forsvinder.",
    ring: 3,
  },
  {
    key: "sikkerhed",
    name: "Sofie, IT-ansvarlig",
    who: "Skal godkende appen, før resten af firmaet må bruge den.",
    wants: "Se hvordan login, passkeys og data hænger sammen.",
    worries: "Persondata, adgang efter fratrædelse og hvem der kan se hvad.",
    ring: 4,
  },
  {
    key: "tidlig",
    name: "Ali, tidlig bruger",
    who: "Har selv valgt at se nye features, før de er færdige.",
    wants: "Prøve det nye og sige, hvad der mangler.",
    worries: "At beta-features ødelægger det, han allerede bruger.",
    ring: 2,
  },
];

export const PLAYBOOKS: Playbook[] = [
  {
    key: "lone-kom-i-gang",
    archetype: "ny-bruger",
    title: "Lone kommer i gang",
    start: "/",
    tasks: [
      { id: "forsiden", title: "Forstår hun på forsiden, hvad appen er til?" },
      { id: "profil", title: "Sæt navn og profilbillede under Konto" },
      { id: "passkey", title: "Opret en passkey, når appen foreslår det" },
      { id: "privatliv", title: "Find ud af, hvilke data appen gemmer om hende" },
    ],
  },
  {
    key: "kasper-klip",
    archetype: "travl-medarbejder",
    title: "Kasper gemmer og finder et klip",
    start: "/klip",
    tasks: [
      { id: "gem", title: "Gem et link som klip" },
      { id: "find", title: "Find klippet igen med søgning" },
      { id: "fil", title: "Upload et billede under Filer og hent det igen" },
      { id: "mobil", title: "Gør det samme på /m fra telefonen" },
    ],
  },
  {
    key: "sofie-sikkerhed",
    archetype: "sikkerhed",
    title: "Sofie tjekker om det holder",
    start: "/konto",
    tasks: [
      { id: "faktorer", title: "Se hvilke loginmetoder der findes, og slå Kræv passkey til" },
      { id: "sessioner", title: "Find aktive sessioner og log en anden enhed ud" },
      { id: "indsigt", title: "Hent en indsigt i sine egne data" },
      { id: "sletning", title: "Find ud af, hvordan en konto slettes" },
    ],
  },
  {
    key: "ali-beta",
    archetype: "tidlig",
    title: "Ali prøver det nye",
    start: "/konto",
    tasks: [
      { id: "niveau", title: "Find Dit niveau og vælg ring 2" },
      { id: "nyt", title: "Find mindst én feature, der ikke var der før" },
      { id: "feedback", title: "Giv feedback på den med et billede" },
    ],
  },
];
