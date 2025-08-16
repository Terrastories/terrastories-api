# **4. Authentication & Authorization**

## **4.1. Authentication**

- **Mechanism**: The original Rails application uses the **Devise gem** for session-based authentication.
- **Migration Strategy**: The new TypeScript API will replicate this behavior. A user will authenticate with an email and password, and the server will return a session cookie (connect.sid) to be used for subsequent authenticated requests.

## **4.2. Authorization (Roles)**

Terrastories uses a role-based access control (RBAC) system. A user's role determines what actions they can perform.

- **Super Admin**: Has full control over all communities and users. Can create new communities and assign community admins.
- **Community Admin**: Has full control over a single community. Can manage users, stories, places, and speakers within that community.
- **Editor**: Can create, edit, and delete content (stories, places, speakers) within their assigned community.
- **Viewer**: Can view all content within their community, including restricted stories. Cannot create or edit content.

Access control is enforced at the controller/route level, ensuring that users can only access resources and perform actions permitted by their role. For example, all /member routes are restricted to authenticated users, and /super_admin routes are restricted to users with the super_admin role.
