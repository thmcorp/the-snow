# THM Snow

Salt and clearing log for THM crews. It's a web app that drivers add to their phone's home screen.

- **Salt:** the run starts by GPS when the truck reaches the first property. Drivers tap "Salted drive lanes" or "Salted walkways", then Full, Half, or a custom fraction. There's also a salt fill-up card (bulk or bags).
- **Clearing:** the owner starts a storm, and every crew checks off drive lanes and walkways live.
- **Logs (owner):** a live main log in the Excel sheet layout. The Excel download has three tabs: Main log, Salt fill-ups, and Log data.
- **Crew (owner):** who's signed in, who's on a run, and where.

## How it's built

- Plain HTML, CSS, and JS with no build step, hosted on GitHub Pages.
- The data lives in Supabase (Postgres). Every read and write goes through one database function, `api()`, which checks the crew or owner PIN. All tables have row-level security on, with no direct access.
- If the phone loses signal, taps are saved on the phone and sent automatically when service comes back.

## Setup

1. Create a Supabase project. Open the SQL Editor and run the private `setup.sql`, which has the schema, PINs, and properties. It is kept out of this public repo because it has PINs and gate codes. `supabase/schema.sql` here is the same schema without data.
2. In `config.js`, put the Project URL and the anon public key, found under Project Settings > API.
3. Turn on GitHub Pages from the `main` branch.

To change a PIN, run this in the SQL Editor:
`update settings set crew_pin = crypt('NEWPIN', gen_salt('bf')) where id = 1;`
(Use `owner_pin` for the owner PIN.)
