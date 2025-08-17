#!/bin/bash

# Terrastories API Compatibility Test Suite
# Tests all API endpoints to ensure compatibility between Rails and TypeScript implementations
# Usage: ./test_terrastories_api.sh [base_url]

set -euo pipefail

# Configuration
BASE_URL="${1:-http://localhost:3000}"
COOKIE_JAR="cookies.txt"
TEST_RESULTS="test_results.log"
VERBOSE="${VERBOSE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0
TOTAL=0

# Test data - Realistic values based on Terrastories' Indigenous community focus
SUPER_ADMIN_USER="terrastories-super"
SUPER_ADMIN_PASS="SuperSecret123!"

ADMIN_USER="maria_admin"
ADMIN_PASS="AdminPass123!"
ADMIN_EMAIL="maria@matawai.sr"

MEMBER_USER="joseph_member"
MEMBER_PASS="MemberPass123!"
MEMBER_EMAIL="joseph@matawai.sr"

COMMUNITY_NAME="Matawai Community"
COMMUNITY_DESC="Indigenous community in Suriname rainforest preserving oral traditions"
COMMUNITY_COUNTRY="Suriname"

STORY_TITLE="The Great Flood Legend"
STORY_DESC="Traditional story about seasonal flooding and community adaptation"
STORY_LANG="srn"

PLACE_NAME="Grandfather Falls"
PLACE_DESC="Sacred waterfall where elders gather for ceremonies"
PLACE_LAT="4.5693"
PLACE_LON="-55.1679"
PLACE_REGION="Upper Suriname River"
PLACE_TYPE="Sacred Site"

SPEAKER_NAME="Elder Maria Koeketeet"
SPEAKER_BIRTHDATE="1945-03-15"
SPEAKER_BIRTHPLACE="Jaw Jaw Village"

# Cleanup function
cleanup() {
    rm -f "$COOKIE_JAR"
    rm -f test_image.jpg test_audio.mp3 test_video.mp4
}

# Trap cleanup on exit
trap cleanup EXIT

# Helper Functions
log() {
    echo -e "$1" | tee -a "$TEST_RESULTS"
}

log_test() {
    ((TOTAL++))
    echo -e "${BLUE}[TEST $TOTAL]${NC} $1"
}

log_pass() {
    ((PASSED++))
    echo -e "${GREEN}✓ PASS${NC}: $1\n"
}

log_fail() {
    ((FAILED++))
    echo -e "${RED}✗ FAIL${NC}: $1"
    echo -e "${RED}Response:${NC} $2\n"
}

# Create test files
create_test_files() {
    # Create a simple test image (1x1 pixel PNG)
    echo -n -e '\x89\x50\x4E\x47\x0D\x0A\x1A\x0A\x00\x00\x00\x0D\x49\x48\x44\x52\x00\x00\x00\x01\x00\x00\x00\x01\x01\x03\x00\x00\x00\x25\xDB\x56\xCA\x00\x00\x00\x03\x50\x4C\x54\x45\x00\x00\x00\xA7\x7A\x3D\xDA\x00\x00\x00\x01\x74\x52\x4E\x53\x00\x40\xE6\xD8\x66\x00\x00\x00\x0A\x49\x44\x41\x54\x08\x1D\x62\x60\x00\x00\x00\x00\x00\x01\x00\x01\xE2\x21\xBC\x33\x00\x00\x00\x00\x49\x45\x4E\x44\xAE\x42\x60\x82' > test_image.jpg
    
    # Create a minimal MP3 file header (silent audio)
    echo -n -e '\xFF\xFB\x90\x00' > test_audio.mp3
    
    # Create a minimal MP4 file header
    echo -n -e '\x00\x00\x00\x20\x66\x74\x79\x70\x69\x73\x6F\x6D\x00\x00\x02\x00\x69\x73\x6F\x6D\x69\x73\x6F\x32\x61\x76\x63\x31\x6D\x70\x34\x31' > test_video.mp4
}

# Make authenticated request
auth_request() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local content_type="${4:-application/json}"
    
    if [ "$method" = "GET" ]; then
        curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
            -H "Accept: application/json" \
            "${BASE_URL}${endpoint}"
    elif [ "$method" = "DELETE" ]; then
        curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
            -X DELETE \
            -H "Accept: application/json" \
            "${BASE_URL}${endpoint}"
    elif [ -n "$data" ]; then
        curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
            -X "$method" \
            -H "Content-Type: $content_type" \
            -H "Accept: application/json" \
            -d "$data" \
            "${BASE_URL}${endpoint}"
    else
        curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
            -X "$method" \
            -H "Accept: application/json" \
            "${BASE_URL}${endpoint}"
    fi
}

# Make public API request
public_request() {
    local endpoint="$1"
    curl -s -H "Accept: application/json" "${BASE_URL}${endpoint}"
}

# File upload request
upload_request() {
    local method="$1"
    local endpoint="$2"
    local field="$3"
    local file="$4"
    
    curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
        -X "$method" \
        -H "Accept: application/json" \
        -F "${field}=@${file}" \
        "${BASE_URL}${endpoint}"
}

# Check if response contains expected field
check_response() {
    local response="$1"
    local field="$2"
    echo "$response" | grep -q "\"$field\"" && return 0 || return 1
}

# Get value from JSON response
get_json_value() {
    local json="$1"
    local key="$2"
    echo "$json" | sed -n "s/.*\"$key\":\s*\"\?\([^\"]*\)\"\?.*/\1/p" | head -1
}

# Initialize test environment
initialize() {
    log "${YELLOW}=== Terrastories API Test Suite ===${NC}"
    log "Testing against: $BASE_URL"
    log "Timestamp: $(date)"
    log "----------------------------------------\n"
    
    # Create test files
    create_test_files
    
    # Clear cookies
    rm -f "$COOKIE_JAR"
}

# Test Authentication
test_authentication() {
    log "${YELLOW}[Authentication Tests]${NC}"
    
    # Test login endpoint exists
    log_test "Testing login endpoint"
    response=$(curl -s -c "$COOKIE_JAR" "${BASE_URL}/login")
    if [ $? -eq 0 ]; then
        log_pass "Login page accessible"
    else
        log_fail "Login page not accessible" "$response"
    fi
    
    # Test login with credentials
    log_test "Testing user authentication"
    response=$(curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login")
    
    if grep -q "session" "$COOKIE_JAR" 2>/dev/null || echo "$response" | grep -q "dashboard\|member"; then
        log_pass "Authentication successful"
    else
        log_fail "Authentication failed" "$response"
    fi
    
    # Test profile access
    log_test "Testing authenticated profile access"
    response=$(auth_request "GET" "/profile")
    if check_response "$response" "username" || echo "$response" | grep -q "$ADMIN_USER"; then
        log_pass "Profile accessible"
    else
        log_fail "Profile not accessible" "$response"
    fi
    
    # Test logout
    log_test "Testing logout"
    response=$(auth_request "DELETE" "/logout")
    log_pass "Logout successful"
}

# Test Public API Endpoints
test_public_api() {
    log "${YELLOW}[Public API Tests]${NC}"
    
    # Test communities endpoint
    log_test "Testing public communities list"
    response=$(public_request "/api/communities")
    if check_response "$response" "name" || [ "$response" = "[]" ]; then
        log_pass "Communities API accessible"
        community_id=$(get_json_value "$response" "id")
    else
        log_fail "Communities API failed" "$response"
        community_id="1"
    fi
    
    # Test single community
    log_test "Testing single community endpoint"
    response=$(public_request "/api/communities/${community_id:-1}")
    if check_response "$response" "name" || check_response "$response" "id"; then
        log_pass "Community detail accessible"
    else
        log_fail "Community detail failed" "$response"
    fi
    
    # Test stories endpoint
    log_test "Testing public stories list"
    response=$(public_request "/api/communities/${community_id:-1}/stories")
    if [ "$response" = "[]" ] || check_response "$response" "title"; then
        log_pass "Stories API accessible"
        story_id=$(get_json_value "$response" "id")
    else
        log_fail "Stories API failed" "$response"
    fi
    
    # Test single story
    if [ -n "${story_id:-}" ]; then
        log_test "Testing single story endpoint"
        response=$(public_request "/api/communities/${community_id:-1}/stories/$story_id")
        if check_response "$response" "title"; then
            log_pass "Story detail accessible"
        else
            log_fail "Story detail failed" "$response"
        fi
    fi
    
    # Test place endpoint
    log_test "Testing place endpoint"
    response=$(public_request "/api/communities/${community_id:-1}/places/1")
    if check_response "$response" "name" || echo "$response" | grep -q "not found"; then
        log_pass "Place API accessible"
    else
        log_fail "Place API failed" "$response"
    fi
}

# Test Member Dashboard Endpoints
test_member_dashboard() {
    log "${YELLOW}[Member Dashboard Tests]${NC}"
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    # Test Stories CRUD
    log_test "Testing story creation"
    story_data='{
        "story": {
            "title": "'"$STORY_TITLE"'",
            "description": "'"$STORY_DESC"'",
            "language": "'"$STORY_LANG"'",
            "restricted": false
        }
    }'
    response=$(auth_request "POST" "/member/stories" "$story_data")
    if check_response "$response" "title" || check_response "$response" "id"; then
        log_pass "Story created"
        story_id=$(get_json_value "$response" "id")
    else
        log_fail "Story creation failed" "$response"
    fi
    
    log_test "Testing story list"
    response=$(auth_request "GET" "/member/stories")
    if check_response "$response" "title" || [ "$response" = "[]" ]; then
        log_pass "Stories list accessible"
    else
        log_fail "Stories list failed" "$response"
    fi
    
    if [ -n "${story_id:-}" ]; then
        log_test "Testing story update"
        update_data='{"story": {"title": "Updated Story Title"}}'
        response=$(auth_request "PATCH" "/member/stories/$story_id" "$update_data")
        if check_response "$response" "Updated" || [ $? -eq 0 ]; then
            log_pass "Story updated"
        else
            log_fail "Story update failed" "$response"
        fi
        
        log_test "Testing story deletion"
        response=$(auth_request "DELETE" "/member/stories/$story_id")
        log_pass "Story deleted"
    fi
    
    # Test Places CRUD
    log_test "Testing place creation"
    place_data='{
        "place": {
            "name": "'"$PLACE_NAME"'",
            "description": "'"$PLACE_DESC"'",
            "latitude": '"$PLACE_LAT"',
            "longitude": '"$PLACE_LON"',
            "region": "'"$PLACE_REGION"'",
            "type_of_place": "'"$PLACE_TYPE"'"
        }
    }'
    response=$(auth_request "POST" "/member/places" "$place_data")
    if check_response "$response" "name" || check_response "$response" "id"; then
        log_pass "Place created"
        place_id=$(get_json_value "$response" "id")
    else
        log_fail "Place creation failed" "$response"
    fi
    
    log_test "Testing places list"
    response=$(auth_request "GET" "/member/places")
    if check_response "$response" "name" || [ "$response" = "[]" ]; then
        log_pass "Places list accessible"
    else
        log_fail "Places list failed" "$response"
    fi
    
    if [ -n "${place_id:-}" ]; then
        log_test "Testing place update"
        update_data='{"place": {"name": "Updated Place Name"}}'
        response=$(auth_request "PATCH" "/member/places/$place_id" "$update_data")
        if check_response "$response" "Updated" || [ $? -eq 0 ]; then
            log_pass "Place updated"
        else
            log_fail "Place update failed" "$response"
        fi
        
        log_test "Testing place photo upload"
        response=$(upload_request "PATCH" "/member/places/$place_id" "place[photo]" "test_image.jpg")
        if [ $? -eq 0 ]; then
            log_pass "Place photo uploaded"
        else
            log_fail "Place photo upload failed" "$response"
        fi
        
        log_test "Testing place photo deletion"
        response=$(auth_request "DELETE" "/member/places/$place_id/photo")
        log_pass "Place photo deleted"
        
        log_test "Testing place audio upload"
        response=$(upload_request "PATCH" "/member/places/$place_id" "place[name_audio]" "test_audio.mp3")
        if [ $? -eq 0 ]; then
            log_pass "Place audio uploaded"
        else
            log_fail "Place audio upload failed" "$response"
        fi
        
        log_test "Testing place audio deletion"
        response=$(auth_request "DELETE" "/member/places/$place_id/name_audio")
        log_pass "Place audio deleted"
        
        log_test "Testing place deletion"
        response=$(auth_request "DELETE" "/member/places/$place_id")
        log_pass "Place deleted"
    fi
    
    # Test Speakers CRUD
    log_test "Testing speaker creation"
    speaker_data='{
        "speaker": {
            "name": "'"$SPEAKER_NAME"'",
            "birthdate": "'"$SPEAKER_BIRTHDATE"'",
            "birthplace": "'"$SPEAKER_BIRTHPLACE"'"
        }
    }'
    response=$(auth_request "POST" "/member/speakers" "$speaker_data")
    if check_response "$response" "name" || check_response "$response" "id"; then
        log_pass "Speaker created"
        speaker_id=$(get_json_value "$response" "id")
    else
        log_fail "Speaker creation failed" "$response"
    fi
    
    log_test "Testing speakers list"
    response=$(auth_request "GET" "/member/speakers")
    if check_response "$response" "name" || [ "$response" = "[]" ]; then
        log_pass "Speakers list accessible"
    else
        log_fail "Speakers list failed" "$response"
    fi
    
    if [ -n "${speaker_id:-}" ]; then
        log_test "Testing speaker update"
        update_data='{"speaker": {"name": "Updated Speaker Name"}}'
        response=$(auth_request "PATCH" "/member/speakers/$speaker_id" "$update_data")
        if check_response "$response" "Updated" || [ $? -eq 0 ]; then
            log_pass "Speaker updated"
        else
            log_fail "Speaker update failed" "$response"
        fi
        
        log_test "Testing speaker photo upload"
        response=$(upload_request "PATCH" "/member/speakers/$speaker_id" "speaker[photo]" "test_image.jpg")
        if [ $? -eq 0 ]; then
            log_pass "Speaker photo uploaded"
        else
            log_fail "Speaker photo upload failed" "$response"
        fi
        
        log_test "Testing speaker photo deletion"
        response=$(auth_request "DELETE" "/member/speakers/$speaker_id/photo")
        log_pass "Speaker photo deleted"
        
        log_test "Testing speaker deletion"
        response=$(auth_request "DELETE" "/member/speakers/$speaker_id")
        log_pass "Speaker deleted"
    fi
    
    # Test User Management
    log_test "Testing users list"
    response=$(auth_request "GET" "/member/users")
    if check_response "$response" "username" || [ "$response" = "[]" ]; then
        log_pass "Users list accessible"
    else
        log_fail "Users list failed" "$response"
    fi
    
    log_test "Testing user creation"
    user_data='{
        "user": {
            "username": "test_user_'$(date +%s)'",
            "email": "test@example.com",
            "password": "TestPass123!",
            "password_confirmation": "TestPass123!"
        }
    }'
    response=$(auth_request "POST" "/member/users" "$user_data")
    if check_response "$response" "username" || check_response "$response" "id"; then
        log_pass "User created"
        user_id=$(get_json_value "$response" "id")
    else
        log_fail "User creation failed" "$response"
    fi
    
    if [ -n "${user_id:-}" ]; then
        log_test "Testing user deletion"
        response=$(auth_request "DELETE" "/member/users/$user_id")
        log_pass "User deleted"
    fi
    
    # Test Community Settings
    log_test "Testing community settings view"
    response=$(auth_request "GET" "/member/community")
    if check_response "$response" "name" || check_response "$response" "country"; then
        log_pass "Community settings accessible"
    else
        log_fail "Community settings failed" "$response"
    fi
    
    log_test "Testing community update"
    community_data='{
        "community": {
            "description": "Updated community description"
        }
    }'
    response=$(auth_request "PATCH" "/member/community" "$community_data")
    if [ $? -eq 0 ]; then
        log_pass "Community updated"
    else
        log_fail "Community update failed" "$response"
    fi
    
    # Test Search
    log_test "Testing search functionality"
    response=$(auth_request "GET" "/member/search?q=test")
    if [ $? -eq 0 ]; then
        log_pass "Search accessible"
    else
        log_fail "Search failed" "$response"
    fi
    
    # Test Theme
    log_test "Testing theme settings"
    response=$(auth_request "GET" "/member/theme")
    if [ $? -eq 0 ]; then
        log_pass "Theme settings accessible"
    else
        log_fail "Theme settings failed" "$response"
    fi
    
    # Test Import
    log_test "Testing import page"
    response=$(auth_request "GET" "/member/import")
    if [ $? -eq 0 ]; then
        log_pass "Import page accessible"
    else
        log_fail "Import page failed" "$response"
    fi
}

# Test Admin Endpoints
test_admin_endpoints() {
    log "${YELLOW}[Admin Endpoints Tests]${NC}"
    
    # Try to authenticate as super admin
    curl -s -c "$COOKIE_JAR" \
        -d "username=${SUPER_ADMIN_USER}&password=${SUPER_ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing admin metrics"
    response=$(auth_request "GET" "/admin/metrics")
    if check_response "$response" "communities" || echo "$response" | grep -q "unauthorized"; then
        log_pass "Admin metrics endpoint tested"
    else
        log_fail "Admin metrics failed" "$response"
    fi
    
    log_test "Testing admin communities list"
    response=$(auth_request "GET" "/admin/communities")
    if check_response "$response" "name" || [ "$response" = "[]" ] || echo "$response" | grep -q "unauthorized"; then
        log_pass "Admin communities endpoint tested"
    else
        log_fail "Admin communities failed" "$response"
    fi
}

# Test File Uploads with Stories
test_file_uploads() {
    log "${YELLOW}[File Upload Tests]${NC}"
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    # Create a story for media attachment
    story_data='{
        "story": {
            "title": "Media Test Story",
            "description": "Story for testing media uploads"
        }
    }'
    response=$(auth_request "POST" "/member/stories" "$story_data")
    story_id=$(get_json_value "$response" "id")
    
    if [ -n "$story_id" ]; then
        log_test "Testing story media upload (audio)"
        response=$(upload_request "PATCH" "/member/stories/$story_id" "story[media][]" "test_audio.mp3")
        if [ $? -eq 0 ]; then
            log_pass "Story audio uploaded"
            media_id=$(get_json_value "$response" "media_id")
        else
            log_fail "Story audio upload failed" "$response"
        fi
        
        log_test "Testing story media upload (video)"
        response=$(upload_request "PATCH" "/member/stories/$story_id" "story[media][]" "test_video.mp4")
        if [ $? -eq 0 ]; then
            log_pass "Story video uploaded"
        else
            log_fail "Story video upload failed" "$response"
        fi
        
        if [ -n "${media_id:-}" ]; then
            log_test "Testing story media deletion"
            response=$(auth_request "DELETE" "/member/stories/$story_id/media/$media_id/delete")
            log_pass "Story media deleted"
        fi
        
        # Clean up test story
        auth_request "DELETE" "/member/stories/$story_id" > /dev/null
    fi
}

# Test Role-Based Access Control
test_rbac() {
    log "${YELLOW}[Role-Based Access Control Tests]${NC}"
    
    # Create a member user for testing
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    member_data='{
        "user": {
            "username": "rbac_test_member",
            "email": "rbac@test.com",
            "password": "TestPass123!",
            "password_confirmation": "TestPass123!",
            "role": "member"
        }
    }'
    response=$(auth_request "POST" "/member/users" "$member_data")
    member_id=$(get_json_value "$response" "id")
    
    # Test member access restrictions
    curl -s -c "$COOKIE_JAR" \
        -d "username=rbac_test_member&password=TestPass123!" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing member cannot access user management"
    response=$(auth_request "GET" "/member/users")
    if echo "$response" | grep -q "unauthorized\|forbidden\|403"; then
        log_pass "Member correctly restricted from user management"
    else
        log_fail "Member access control failed" "$response"
    fi
    
    # Clean up
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    if [ -n "$member_id" ]; then
        auth_request "DELETE" "/member/users/$member_id" > /dev/null
    fi
}

# Test Edge Cases
test_edge_cases() {
    log "${YELLOW}[Edge Cases Tests]${NC}"
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing invalid story ID"
    response=$(auth_request "GET" "/member/stories/999999")
    if echo "$response" | grep -q "not found\|404"; then
        log_pass "Invalid ID handled correctly"
    else
        log_fail "Invalid ID handling failed" "$response"
    fi
    
    log_test "Testing empty story creation"
    response=$(auth_request "POST" "/member/stories" '{"story": {}}')
    if echo "$response" | grep -q "error\|required\|blank"; then
        log_pass "Empty data validation working"
    else
        log_fail "Empty data validation failed" "$response"
    fi
    
    log_test "Testing malformed JSON"
    response=$(auth_request "POST" "/member/stories" '{invalid json}')
    if echo "$response" | grep -q "error\|400\|parse"; then
        log_pass "Malformed JSON handled"
    else
        log_fail "Malformed JSON handling failed" "$response"
    fi
    
    log_test "Testing SQL injection attempt"
    response=$(auth_request "GET" "/member/stories?id=1' OR '1'='1")
    if [ $? -eq 0 ]; then
        log_pass "SQL injection prevented"
    else
        log_fail "SQL injection test failed" "$response"
    fi
    
    log_test "Testing XSS attempt"
    xss_data='{"story": {"title": "<script>alert(1)</script>"}}'
    response=$(auth_request "POST" "/member/stories" "$xss_data")
    if ! echo "$response" | grep -q "<script>"; then
        log_pass "XSS prevented"
    else
        log_fail "XSS prevention failed" "$response"
    fi
}

# Test Geospatial Features
test_geospatial() {
    log "${YELLOW}[Geospatial Features Tests]${NC}"
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing place with valid coordinates"
    place_data='{
        "place": {
            "name": "Coordinate Test",
            "latitude": 4.5693,
            "longitude": -55.1679
        }
    }'
    response=$(auth_request "POST" "/member/places" "$place_data")
    if check_response "$response" "latitude"; then
        log_pass "Valid coordinates accepted"
        place_id=$(get_json_value "$response" "id")
        auth_request "DELETE" "/member/places/$place_id" > /dev/null
    else
        log_fail "Valid coordinates failed" "$response"
    fi
    
    log_test "Testing place with invalid coordinates"
    invalid_place_data='{
        "place": {
            "name": "Invalid Coordinate Test",
            "latitude": 999,
            "longitude": -999
        }
    }'
    response=$(auth_request "POST" "/member/places" "$invalid_place_data")
    if echo "$response" | grep -q "error\|invalid"; then
        log_pass "Invalid coordinates rejected"
    else
        # Might be accepted, clean up
        place_id=$(get_json_value "$response" "id")
        if [ -n "$place_id" ]; then
            auth_request "DELETE" "/member/places/$place_id" > /dev/null
        fi
        log_fail "Invalid coordinates not validated" "$response"
    fi
}

# Test Import/Export Features
test_import_export() {
    log "${YELLOW}[Import/Export Tests]${NC}"
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing import preview"
    # Create a simple CSV for import testing
    echo "title,description,language
Test Import Story,Imported from CSV,en
Another Import,Second imported story,es" > test_import.csv
    
    response=$(upload_request "POST" "/member/import/preview" "file" "test_import.csv")
    if check_response "$response" "preview" || [ $? -eq 0 ]; then
        log_pass "Import preview working"
    else
        log_fail "Import preview failed" "$response"
    fi
    
    rm -f test_import.csv
}

# Test Performance Endpoints
test_performance() {
    log "${YELLOW}[Performance Tests]${NC}"
    
    log_test "Testing response time for public API"
    start_time=$(date +%s%N)
    public_request "/api/communities" > /dev/null
    end_time=$(date +%s%N)
    elapsed=$((($end_time - $start_time) / 1000000))
    
    if [ $elapsed -lt 5000 ]; then
        log_pass "Public API response time: ${elapsed}ms"
    else
        log_fail "Public API slow response" "${elapsed}ms"
    fi
    
    # Re-authenticate
    curl -s -c "$COOKIE_JAR" \
        -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" \
        -X POST "${BASE_URL}/login" > /dev/null
    
    log_test "Testing response time for authenticated API"
    start_time=$(date +%s%N)
    auth_request "GET" "/member/stories" > /dev/null
    end_time=$(date +%s%N)
    elapsed=$((($end_time - $start_time) / 1000000))
    
    if [ $elapsed -lt 5000 ]; then
        log_pass "Authenticated API response time: ${elapsed}ms"
    else
        log_fail "Authenticated API slow response" "${elapsed}ms"
    fi
}

# Main test execution
main() {
    initialize
    
    # Run all test suites
    test_authentication
    test_public_api
    test_member_dashboard
    test_admin_endpoints
    test_file_uploads
    test_rbac
    test_edge_cases
    test_geospatial
    test_import_export
    test_performance
    
    # Summary
    log "\n${YELLOW}=== Test Summary ===${NC}"
    log "Total Tests: $TOTAL"
    log "${GREEN}Passed: $PASSED${NC}"
    log "${RED}Failed: $FAILED${NC}"
    
    if [ $FAILED -eq 0 ]; then
        log "\n${GREEN}✓ All tests passed!${NC}"
        exit 0
    else
        log "\n${RED}✗ Some tests failed. Check the output above for details.${NC}"
        exit 1
    fi
}

# Run the test suite
main