/**
 * Team name → flagcdn code, so any nation in tournament_sim.json renders a real
 * flag (the mock teams.ts only covers 8 sides). Codes are ISO-3166 alpha-2,
 * except the UK home nations which use flagcdn's gb-* subdivisions.
 *
 * Keys are lowercased; look up via `flagUrl(name)`.
 */
const FLAG_CODES: Record<string, string> = {
  // Hosts + CONCACAF
  "united states": "us", "canada": "ca", "mexico": "mx", "costa rica": "cr",
  "panama": "pa", "jamaica": "jm", "honduras": "hn",
  // UEFA
  "france": "fr", "england": "gb-eng", "spain": "es", "portugal": "pt",
  "netherlands": "nl", "belgium": "be", "germany": "de", "croatia": "hr",
  "italy": "it", "switzerland": "ch", "denmark": "dk", "austria": "at",
  "ukraine": "ua", "turkey": "tr", "serbia": "rs", "poland": "pl",
  "norway": "no", "scotland": "gb-sct", "wales": "gb-wls",
  "northern ireland": "gb-nir", "republic of ireland": "ie", "greece": "gr",
  "hungary": "hu", "romania": "ro", "czech republic": "cz", "slovakia": "sk",
  "slovenia": "si", "russia": "ru", "sweden": "se", "iceland": "is",
  "finland": "fi", "bosnia and herzegovina": "ba",
  // CONMEBOL
  "brazil": "br", "argentina": "ar", "uruguay": "uy", "colombia": "co",
  "ecuador": "ec", "paraguay": "py", "peru": "pe", "chile": "cl",
  "venezuela": "ve", "bolivia": "bo",
  // CAF
  "morocco": "ma", "senegal": "sn", "nigeria": "ng", "egypt": "eg",
  "algeria": "dz", "ivory coast": "ci", "cameroon": "cm", "ghana": "gh",
  "tunisia": "tn", "south africa": "za", "mali": "ml", "cape verde": "cv",
  "dr congo": "cd",
  // AFC
  "japan": "jp", "south korea": "kr", "iran": "ir", "australia": "au",
  "saudi arabia": "sa", "qatar": "qa", "iraq": "iq", "uzbekistan": "uz",
  "united arab emirates": "ae", "jordan": "jo", "oman": "om",
  "china pr": "cn", "china": "cn", "india": "in", "north korea": "kp",
  // OFC
  "new zealand": "nz",
};

/** flagcdn URL for a team name, or undefined if we don't have a code for it. */
export function flagUrl(name: string, width = 160): string | undefined {
  const code = FLAG_CODES[name.trim().toLowerCase()];
  return code ? `https://flagcdn.com/w${width}/${code}.png` : undefined;
}

export default FLAG_CODES;
