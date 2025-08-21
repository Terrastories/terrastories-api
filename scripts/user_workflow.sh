#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
BASE_URL="http://localhost:3000/api/v1"
COOKIE_JAR=$(mktemp)
echo "Cookie jar created at: $COOKIE_JAR"

# Cleanup function to be called on script exit
cleanup() {
  echo "Cleaning up..."
  rm -f "$COOKIE_JAR"
  
  # Delete created resources if they exist (ignore failures for clean exit)
  if [ ! -z "$COMMUNITY_ID" ] && [ "$COMMUNITY_ID" != "null" ]; then
    echo "Attempting to clean up community ID: $COMMUNITY_ID"
    # Note: Community deletion endpoint would be needed for complete cleanup
    # For now, we let the test data accumulate (acceptable for testing)
  fi
  
  echo "Cleanup complete."
}

# Register the cleanup function to be called on EXIT signal
trap cleanup EXIT

# --- User Journey Simulation ---

echo "--- 1. Health Check ---"
HEALTH_URL="http://localhost:3000/health"
curl --fail -sS "$HEALTH_URL"
echo -e "\nHealth check passed."

echo "--- 2a. Create Community ---"
# Generate a random community name to ensure the test is repeatable
RANDOM_COMMUNITY="TestCommunity_$(date +%s)_$RANDOM"
echo "Creating community: $RANDOM_COMMUNITY"
COMMUNITY_RESPONSE=$(curl --fail -sS -X POST \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$RANDOM_COMMUNITY\", \"description\": \"A test community for user workflow\", \"locale\": \"en\"}" \
  "$BASE_URL/communities")

# Extract community ID using jq
COMMUNITY_ID=$(echo "$COMMUNITY_RESPONSE" | jq -r '.data.id')

if [ -z "$COMMUNITY_ID" ] || [ "$COMMUNITY_ID" == "null" ]; then
    echo "Error: Failed to get Community ID from community creation response."
    echo "Response: $COMMUNITY_RESPONSE"
    exit 1
fi
echo "Community created with ID: $COMMUNITY_ID"

echo "--- 2b. User Registration ---"
# Generate a random user email to ensure the test is repeatable
RANDOM_EMAIL="testuser_$(date +%s)_$RANDOM@example.com"
# Generate a secure random password meeting requirements (uppercase, lowercase, numbers, special chars)
# Format: Test + 4 random chars + 4 random numbers + !
if command -v openssl >/dev/null 2>&1 && command -v shuf >/dev/null 2>&1; then
  RANDOM_PASSWORD="Test$(openssl rand -base64 6 | tr -d "=+/" | cut -c1-4)$(shuf -i 1000-9999 -n 1)!"
else
  # Fallback for systems without openssl or shuf
  RANDOM_PASSWORD="Test$(date +%s | tail -c 5)$(echo $RANDOM | tail -c 5)!"
fi
echo "Generated secure password for testing"
echo "Registering user: $RANDOM_EMAIL"
REGISTRATION_RESPONSE=$(curl --fail -sS -X POST \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$RANDOM_EMAIL\", \"password\": \"$RANDOM_PASSWORD\", \"firstName\": \"Test\", \"lastName\": \"User\", \"role\": \"admin\", \"communityId\": $COMMUNITY_ID}" \
  "$BASE_URL/auth/register")

# Extract user ID using jq
USER_ID=$(echo "$REGISTRATION_RESPONSE" | jq -r '.user.id')

if [ -z "$USER_ID" ] || [ "$USER_ID" == "null" ]; then
    echo "Error: Failed to get User ID from registration response."
    echo "Response: $REGISTRATION_RESPONSE"
    exit 1
fi
echo "User registered with ID: $USER_ID in Community ID: $COMMUNITY_ID"

echo "--- 3. User Login ---"
LOGIN_RESPONSE=$(curl --fail -sS -X POST \
  -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$RANDOM_EMAIL\", \"password\": \"$RANDOM_PASSWORD\"}" \
  "$BASE_URL/auth/login")
echo "User logged in."

# Check if session cookie exists
if ! grep -q "sessionId" "$COOKIE_JAR"; then
  echo "Error: Login failed, session cookie not found."
  echo "Response: $LOGIN_RESPONSE"
  exit 1
fi

# NOTE: The following sections are commented out because the corresponding API endpoints
# for creating and managing stories, places, and speakers are not yet implemented
# according to the project roadmap. Once those endpoints are live, these sections
# can be uncommented and tested.

echo "--- 4. Create a Speaker (Placeholder) ---"
# echo "Skipping: /member/speakers endpoint not implemented yet."
# SPEAKER_RESPONSE=$(curl --fail -sS -X POST \
#   -b "$COOKIE_JAR" \
#   -H "Content-Type: application/json" \
#   -d '{"name": "Test Speaker", "bio": "A speaker for testing."}' \
#   "$BASE_URL/member/speakers")
# SPEAKER_ID=$(echo "$SPEAKER_RESPONSE" | jq -r '.data.id')
# echo "Speaker created with ID: $SPEAKER_ID"

echo "--- 5. Create a Place (Placeholder) ---"
# echo "Skipping: /member/places endpoint not implemented yet."
# PLACE_RESPONSE=$(curl --fail -sS -X POST \
#   -b "$COOKIE_JAR" \
#   -H "Content-Type: application/json" \
#   -d '{"name": "Test Place", "point": "POINT(-74.0060 40.7128)"}' \
#   "$BASE_URL/member/places")
# PLACE_ID=$(echo "$PLACE_RESPONSE" | jq -r '.data.id')
# echo "Place created with ID: $PLACE_ID"

echo "--- 6. Create a Story (Placeholder) ---"
# echo "Skipping: Depends on story creation."
# STORY_RESPONSE=$(curl --fail -sS -X POST \
#   -b "$COOKIE_JAR" \
#   -H "Content-Type: application/json" \
#   -d "{\"title\": \"Test Story\", \"description\": \"A story for testing.\", \"speaker_ids\": [$SPEAKER_ID], \"place_ids\": [$PLACE_ID]}" \
#   "$BASE_URL/member/stories")
# STORY_ID=$(echo "$STORY_RESPONSE" | jq -r '.data.id')
# echo "Story created with ID: $STORY_ID"

echo "--- 7. Upload Media to Story (Placeholder) ---"
# echo "Skipping: Depends on story creation."
# touch dummy_image.jpg
# curl --fail -sS -X POST \
#   -b "$COOKIE_JAR" \
#   -F "file=@dummy_image.jpg" \
#   "$BASE_URL/member/stories/$STORY_ID/media"
# rm dummy_image.jpg
# echo "Media uploaded."

echo "--- 8. View Public Content (Placeholder) ---"
# echo "Skipping: Depends on story creation."
# curl --fail -sS "$BASE_URL/communities/$COMMUNITY_ID/stories/$STORY_ID"
# echo -e "\nPublic content viewed."

echo "--- 9. User Logout ---"
curl --fail -sS -X POST -b "$COOKIE_JAR" "$BASE_URL/auth/logout"
echo -e "\nUser logged out."

echo "--- User Journey Simulation Completed Successfully ---"

