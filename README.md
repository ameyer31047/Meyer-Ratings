# Meyer Ratings

College basketball, baseball and football ratings. Published with GitHub Pages.

- `index.html`: the site.
- `data.json`: tonight's ratings, scores and sims, written by the nightly job. The site loads it on open.
- `.github/workflows/nightly.yml`: runs at 12:05 AM Pacific. Run it any time from Actions > Nightly ratings refresh > Run workflow.
- To update the site: replace `index.html` with the new hosting build.

## Settings
In the local HTML file, tune settings, click **Export settings**, and upload the `settings.json` it saves to this repo (root folder, next to index.html). The site and the nightly job both use it. Re-upload whenever you change settings.
