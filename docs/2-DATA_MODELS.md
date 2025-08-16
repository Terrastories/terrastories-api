# **2. Core Data Models**

Terrastories is built around five core models that have intricate relationships.

### **1. Community**

The central organizing entity and the basis for multi-tenancy. All other core data belongs to a Community.

- **Description**: Represents an Indigenous or local community. It controls data sovereignty boundaries, access, and customization (themes, map styles).
- **Key Fields**: name, slug, description, public_stories.
- **Relationships**: has_many Stories, Places, Speakers, Users, and Themes.

### **2. Story**

The primary content entity, representing oral histories and narratives.

- **Description**: Contains the narrative content, which can be linked to multiple places and speakers.
- **Key Fields**: title, description, language, topic, permission_level.
- **Relationships**:
  - belongs_to a Community.
  - has_and_belongs_to_many Places.
  - has_and_belongs_to_many Speakers.
  - has_many_attached media files (via ActiveStorage in Rails).

### **3. Place**

A geographic location that is part of a story.

- **Description**: Represents a point or region on the map. Places can be associated with multiple stories.
- **Key Fields**: name, description, type_of_place, region, lat, long.
- **Relationships**:
  - belongs_to a Community.
  - has_and_belongs_to_many Stories.
  - has_one_attached photo.
  - has_one_attached name_audio.

### **4. Speaker**

The storyteller or source of a story.

- **Description**: Represents the person who narrated a story.
- **Key Fields**: name, birthdate, photo.
- **Relationships**:
  - belongs_to a Community.
  - has_and_belongs_to_many Stories.

### **5. User**

A registered user who can access and manage content within a community.

- **Description**: Users are scoped to a single community and have different roles (e.g., admin, editor, viewer).
- **Key Fields**: email, role.
- **Relationships**: belongs_to a Community.
