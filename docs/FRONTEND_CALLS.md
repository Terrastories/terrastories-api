## Terrastories API Endpoints

Terrastories is a **map-based storytelling** app built with Ruby on Rails (backend) and React (frontend)[github.com](https://github.com/Terrastories/terrastories#:~:text=Terrastories%20is%20a%20Dockerized%20Rails,entirely%20without%20needing%20internet%20connectivity). The React interface presents an interactive map and story sidebar[github.com](https://github.com/Terrastories/terrastories#:~:text=The%20main%20Terrastories%20interface%20is,landscape%20these%20narratives%20took%20place). To populate the map and dashboards, the front-end makes RESTful calls to the Rails API for each data entity. In particular, it handles **Users**, **Communities**, **Speakers**, **Places**, and **Stories** via JSON endpoints. For example, story cards and their details (including media and location) are fetched from the backend when a user views or clicks a story[github.com](https://github.com/Terrastories/terrastories#:~:text=The%20main%20Terrastories%20interface%20is,landscape%20these%20narratives%20took%20place)[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Click%20or%20press%20on%20one,place%20associated%20with%20the%20story). User roles control access (only `admin`/`editor` can add content)[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views).

The key API calls made by the Terrastories frontend include (verbs are examples – actual endpoints may use an `/api` prefix or versioning):

- `POST /sessions` or `/login` – authenticate a user (sends credentials, receives a session cookie or token).

- `POST /logout` – log out the current user session.

- `GET /communities` – list communities.

- `POST /communities` – create a new community.

- `GET /communities/:id` – view a community.

- `GET /users` – list users (usually admin-only).

- `POST /users` – create a new user (e.g. community admin or viewer).

- `GET /users/:id` – view user details.

- `POST /speakers` – create a speaker profile (requires admin/editor).

- `GET /speakers` – list speakers.

- `GET /speakers/:id` – view a speaker.

- `POST /places` – create a place (requires admin/editor).

- `GET /places` – list places.

- `GET /places/:id` – view a place.

- `POST /stories` – create a story (requires admin/editor).

- `GET /stories` – list stories (visible ones, including filters by permission).

- `GET /stories/:id` – view a story and its media/location.

Each API call returns JSON and is secured by the user’s login. For instance, only a community’s admins/editors can `POST` new speakers, places, or stories[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views). Viewers can only use `GET /stories` or `GET /stories/:id` to read unrestricted content[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views).

## Example Bash Script (All Endpoints)

Below is a **combined Bash script** sketching the calls for setting up entities and logging in. It uses an `API_BASE` variable for easy configuration and prints narrative logs with timestamps. (In practice you’d replace example data and add proper auth headers or cookies.)

bash

```
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"   # Base URL for the Terrastories API
LOGFILE="terrastories-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="cookie-jar.txt"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"
}

# 1. Log in as super admin (seeded user) and save cookies
log "Logging in as super-admin..."
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"superadmin@example.com","password":"changeme"}' \
     | tee -a "$LOGFILE"

# 2. Create a new community
log "Creating a new community..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/communities" \
     -H "Content-Type: application/json" \
     -d '{"name":"Demo Community","description":"Test community"}' \
     | tee -a "$LOGFILE"

# 3. Add an admin user for that community
log "Creating a community admin user..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@demo.com","password":"adminpass","role":"admin","community_id":1}' \
     | tee -a "$LOGFILE"

# 4. Log in as community admin
log "Logging in as community admin..."
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@demo.com","password":"adminpass"}' \
     | tee -a "$LOGFILE"

# 5. Create a speaker, place, and story (as community admin)
log "Creating a speaker..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/speakers" \
     -H "Content-Type: application/json" \
     -d '{"name":"Alice Example","community_id":1}' \
     | tee -a "$LOGFILE"

log "Creating a place..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/places" \
     -H "Content-Type: application/json" \
     -d '{"name":"Sample Place","description":"A test location","latitude":0.5,"longitude":1.2,"community_id":1}' \
     | tee -a "$LOGFILE"

log "Creating a story..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/stories" \
     -H "Content-Type: application/json" \
     -d '{"title":"Test Story","body":"This is a demo story","speaker_ids":[1],"place_ids":[1],"community_id":1}' \
     | tee -a "$LOGFILE"

# 6. Create a viewer user
log "Creating a viewer user..."
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"viewer@demo.com","password":"viewpass","role":"viewer","community_id":1}' \
     | tee -a "$LOGFILE"

# 7. Log in as viewer and fetch the story
log "Logging in as viewer..."
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"viewer@demo.com","password":"viewpass"}' \
     | tee -a "$LOGFILE"

log "Fetching all stories for viewer..."
curl -s -b "$COOKIEJAR" "$API_BASE/stories" | tee -a "$LOGFILE"
```

This script logs each step (prepended with a timestamp) and writes details to a timestamped log file. It demonstrates full **auth handling** (using a cookie jar) and test calls for each entity. You can split or run parts of it for each user story as needed.

## Workflow 1: Super-Admin Flow

bash

```
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow1-superadmin-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="superadmin-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Super-admin logs in
log "Super-admin login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"super@example.com","password":"superpass"}' \
     | tee -a "$LOGFILE"

# Create community
log "Create community \"Lions\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/communities" \
     -H "Content-Type: application/json" \
     -d '{"name":"Lions","description":"Lion tribe community"}' \
     | tee -a "$LOGFILE"

# Create community admin user
log "Create admin user for Lions community"
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionadmin@demo.com","password":"lionpass","role":"admin","community_id":2}' \
     | tee -a "$LOGFILE"
```

This **Super-Admin flow** script logs in as the super-admin (credentials from seeds), then creates a new community and an admin user for it. (Only a super-admin can perform these actions.) The log file will record each request and response.

## Workflow 2: Community-Admin Flow

bash

```
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow2-comadmin-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="comadmin-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Community admin logs in
log "Community-admin login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionadmin@demo.com","password":"lionpass"}' \
     | tee -a "$LOGFILE"

# Create a speaker
log "Create speaker \"Tala\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/speakers" \
     -H "Content-Type: application/json" \
     -d '{"name":"Tala Fireheart","bio":"Storyteller of the lions","community_id":2}' \
     | tee -a "$LOGFILE"

# Create a place
log "Create place \"Sunset Rock\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/places" \
     -H "Content-Type: application/json" \
     -d '{"name":"Sunset Rock","description":"Hilltop meeting spot","latitude":45.0,"longitude":-122.0,"community_id":2}' \
     | tee -a "$LOGFILE"

# Create a story
log "Create story \"Lion Legend\""
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/stories" \
     -H "Content-Type: application/json" \
     -d '{"title":"The Lion Legend","body":"A tale of lions and heroes","speaker_ids":[3],"place_ids":[2],"permission_level":"public","community_id":2}' \
     | tee -a "$LOGFILE"
```

In this **Community-Admin flow**, the admin logs in and creates new content (speaker, place, story) for their community. The UI described that admins/editors can add these entities to link together[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views)[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=A%20Story%20must%20have%20at,on%20the%20Terrastories%20main%20interface). Each `curl` call appends results to the log, showing success or errors.

## Workflow 3: Viewer Flow

bash

```
#!/usr/bin/env bash
API_BASE="${API_BASE:-http://localhost:3000}"
LOGFILE="flow3-viewer-$(date +%Y%m%d-%H%M%S).log"
COOKIEJAR="viewer-cookie.txt"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Community admin logs in (again) and creates a viewer
log "Community-admin login and create viewer"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionadmin@demo.com","password":"lionpass"}' \
     | tee -a "$LOGFILE"
curl -s -b "$COOKIEJAR" -X POST "$API_BASE/users" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionsviewer@demo.com","password":"viewpass","role":"viewer","community_id":2}' \
     | tee -a "$LOGFILE"

# Viewer logs in
log "Viewer login"
curl -s -c "$COOKIEJAR" -X POST "$API_BASE/sessions" \
     -H "Content-Type: application/json" \
     -d '{"email":"lionsviewer@demo.com","password":"viewpass"}' \
     | tee -a "$LOGFILE"

# Viewer fetches stories
log "Viewer fetch stories list"
curl -s -b "$COOKIEJAR" "$API_BASE/stories?community_id=2" | tee -a "$LOGFILE"

log "Viewer fetch details of first story"
curl -s -b "$COOKIEJAR" "$API_BASE/stories/1" | tee -a "$LOGFILE"
```

This **Viewer flow** shows a community-admin creating a new _viewer_ user, who then logs in. The viewer can only make GET requests; e.g. fetching the list of stories and story details. (As noted in the docs, a `viewer` cannot add/edit content[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views).) The script logs these fetch operations, demonstrating that the viewer sees the story created earlier.

Each script prints step-by-step logs (with timestamps) to the console and to a log file for easy human reading. By adjusting the `API_BASE` variable and credentials, you can run these scripts against your Terrastories server.

**Sources:** Terrastories is implemented as a Dockerized Rails+React app[github.com](https://github.com/Terrastories/terrastories#:~:text=Terrastories%20is%20a%20Dockerized%20Rails,entirely%20without%20needing%20internet%20connectivity). It features interactive map/story views and a role-based CMS[github.com](https://github.com/Terrastories/terrastories#:~:text=The%20main%20Terrastories%20interface%20is,landscape%20these%20narratives%20took%20place)[docs.terrastories.app](https://docs.terrastories.app/using-terrastories/using-the-terrastories-member-dashboard/exploring-and-creating-stories-speakers-and-places#:~:text=Adding%20and%20editing%20Terrastories%20data,can%20not%20access%20these%20views), hence the above API workflows mirror the described interfaces.
