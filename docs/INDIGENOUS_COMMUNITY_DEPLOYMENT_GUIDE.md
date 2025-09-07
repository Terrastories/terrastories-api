# Indigenous Community Deployment Guide

## 🌟 Overview

This guide provides comprehensive instructions for deploying the Terrastories TypeScript API in Indigenous community environments, with special consideration for cultural protocols, data sovereignty, and offline-first deployment scenarios.

## 🛡️ Cultural Considerations & Data Sovereignty

### Indigenous Data Sovereignty Principles

Before deployment, ensure your organization understands and commits to:

1. **Community Data Control**: Indigenous communities maintain full control over their cultural data
2. **Elder Content Protection**: Elder-only content is protected by cultural protocol enforcement
3. **Community Isolation**: Each community's data is completely isolated from others
4. **Super Admin Restrictions**: System administrators cannot access community cultural data
5. **Audit Compliance**: All data access is logged for community oversight

### Pre-Deployment Cultural Protocol Checklist

- [ ] **Community Leadership Approval**: Obtained permission from appropriate community leaders
- [ ] **Elder Council Consultation**: Consulted with elders about cultural content guidelines
- [ ] **Data Sovereignty Agreement**: Established clear data ownership and control protocols
- [ ] **Cultural Access Controls**: Configured elder-only content restrictions
- [ ] **Audit Logging Setup**: Enabled comprehensive access logging for community oversight

---

## 🏞️ Deployment Scenarios

### Scenario 1: Urban Community with Reliable Internet

**Best For**: Communities with consistent broadband internet access
**Deployment**: Cloud-hosted with PostgreSQL database
**Backup Strategy**: Automated cloud backups with local copies

### Scenario 2: Remote Community with Limited Internet

**Best For**: Communities with intermittent internet access
**Deployment**: Local server with PostgreSQL, cloud sync when available
**Backup Strategy**: Local automated backups with periodic cloud sync

### Scenario 3: Field Kit - Completely Offline

**Best For**: Remote communities without internet access
**Deployment**: Portable device with SQLite database
**Backup Strategy**: Physical device backups and transfer protocols

---

## 🏗️ Production Deployment (Scenarios 1 & 2)

### Infrastructure Requirements

#### Minimum System Requirements

- **CPU**: 2 cores, 2.4 GHz
- **RAM**: 4 GB (8 GB recommended)
- **Storage**: 50 GB SSD (100 GB+ for media-heavy communities)
- **Network**: Broadband internet (when available)

#### Recommended Production Setup

- **CPU**: 4+ cores, 3.0 GHz
- **RAM**: 8-16 GB
- **Storage**: 200+ GB NVMe SSD
- **Database**: Dedicated PostgreSQL server or managed service
- **Backup**: Automated daily backups with offsite storage

### Docker Production Deployment

#### 1. Server Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker and Docker Compose
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Add user to docker group
sudo usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

#### 2. Application Setup

```bash
# Clone repository
git clone https://github.com/Terrastories/terrastories-api.git
cd terrastories-api

# Create production environment file
cp .env.example .env.production

# Configure production settings
nano .env.production
```

#### 3. Production Environment Configuration

```bash
# .env.production - Indigenous Community Production Settings

# Basic Configuration
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database Configuration (PostgreSQL with PostGIS)
DATABASE_URL=postgresql://terrastories_user:secure_password@localhost:5432/terrastories_production
POSTGRES_DB=terrastories_production
POSTGRES_USER=terrastories_user
POSTGRES_PASSWORD=secure_password

# Security Configuration
JWT_SECRET=your-super-secure-jwt-secret-at-least-32-characters
SESSION_SECRET=your-super-secure-session-secret-at-least-32-characters

# File Storage Configuration
UPLOAD_DIR=./data/uploads
MAX_FILE_SIZE=104857600  # 100MB for cultural media
ALLOWED_FILE_TYPES=image/jpeg,image/png,image/gif,audio/mpeg,audio/wav,video/mp4

# Community Configuration
DEFAULT_COMMUNITY_NAME="Your Community Name"
COMMUNITY_LOCALE=en  # or your Indigenous language code
CULTURAL_PROTOCOLS_ENABLED=true

# Logging Configuration
LOG_LEVEL=info
AUDIT_LOGGING=true  # Critical for Indigenous data sovereignty
CULTURAL_ACCESS_LOGGING=true

# SSL/TLS Configuration (for production)
SSL_ENABLED=true
SSL_CERT_PATH=/path/to/ssl/cert.pem
SSL_KEY_PATH=/path/to/ssl/private-key.pem

# Backup Configuration
BACKUP_ENABLED=true
BACKUP_RETENTION_DAYS=90  # Adjust based on community requirements
BACKUP_ENCRYPTION=true
```

#### 4. Deploy with Docker Compose

```bash
# Build and start services
docker-compose -f docker-compose.production.yml up -d

# Run database migrations
docker-compose exec api npm run db:migrate

# Create initial community
docker-compose exec api npm run setup:community

# Verify deployment
curl https://your-domain.com/health
```

#### 5. SSL/TLS Setup (Critical for Cultural Data)

```bash
# Using Let's Encrypt (recommended)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com

# Or use your organization's SSL certificates
# Copy certificates to /etc/ssl/certs/terrastories/
```

---

## 🏕️ Field Kit Deployment (Scenario 3)

### Hardware Requirements

#### Recommended Field Kit Hardware

- **Mini PC/Single Board Computer**: Intel NUC, Raspberry Pi 4 8GB, or similar
- **Storage**: 256+ GB microSD card or SSD (for media storage)
- **Power**: Battery pack or solar charging solution
- **Network**: WiFi hotspot capability for local network access
- **Case**: Ruggedized case for outdoor/remote environments

#### Software Stack

- **OS**: Ubuntu Server 22.04 LTS (lightweight)
- **Database**: SQLite (no server required)
- **Application**: Node.js with TypeScript API
- **UI Access**: Web interface via local WiFi hotspot

### Field Kit Setup Process

#### 1. Base System Installation

```bash
# Flash Ubuntu Server to SD card/SSD
# Boot and complete initial setup

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git and build tools
sudo apt install -y git build-essential
```

#### 2. Application Installation

```bash
# Clone repository
git clone https://github.com/Terrastories/terrastories-api.git
cd terrastories-api

# Install dependencies
npm install --production

# Create field kit environment
cp .env.example .env.field-kit
```

#### 3. Field Kit Environment Configuration

```bash
# .env.field-kit - Indigenous Field Kit Configuration

# Basic Configuration
NODE_ENV=field-kit
PORT=3000
HOST=0.0.0.0

# SQLite Database (offline-first)
DATABASE_URL=sqlite:./data/terrastories_field_kit.db
DB_TYPE=sqlite

# Community Configuration
DEFAULT_COMMUNITY_NAME="Community Field Kit"
COMMUNITY_LOCALE=en
CULTURAL_PROTOCOLS_ENABLED=true
OFFLINE_MODE=true

# File Storage (local only)
UPLOAD_DIR=./data/uploads
MAX_FILE_SIZE=52428800  # 50MB (smaller for field kit storage)
ALLOWED_FILE_TYPES=image/jpeg,image/png,audio/mpeg,audio/wav

# Security (offline environment)
JWT_SECRET=field-kit-secure-secret-change-this
SESSION_SECRET=field-kit-session-secret-change-this

# Logging (local files)
LOG_LEVEL=info
LOG_TO_FILE=true
LOG_FILE_PATH=./logs/field-kit.log
AUDIT_LOGGING=true
CULTURAL_ACCESS_LOGGING=true

# Sync Configuration (for when internet available)
SYNC_ENABLED=false  # Enable when internet available
SYNC_SERVER_URL=https://your-main-server.com/api
```

#### 4. Field Kit Service Setup

```bash
# Create systemd service for auto-start
sudo tee /etc/systemd/system/terrastories-field-kit.service > /dev/null <<EOF
[Unit]
Description=Terrastories Indigenous Field Kit API
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/terrastories-api
Environment=NODE_ENV=field-kit
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
sudo systemctl enable terrastories-field-kit
sudo systemctl start terrastories-field-kit

# Check status
sudo systemctl status terrastories-field-kit
```

#### 5. WiFi Hotspot Setup (for local access)

```bash
# Install hostapd and dnsmasq
sudo apt install -y hostapd dnsmasq

# Configure WiFi hotspot
sudo tee /etc/hostapd/hostapd.conf > /dev/null <<EOF
interface=wlan0
driver=nl80211
ssid=TerrastoriesFieldKit
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=CommunityStories2024
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF

# Enable hotspot on boot
sudo systemctl enable hostapd
```

---

## 🔐 Security Configuration

### Indigenous Data Protection

#### Authentication Security

```bash
# Strong password policies (in application config)
PASSWORD_MIN_LENGTH=12
PASSWORD_REQUIRE_UPPERCASE=true
PASSWORD_REQUIRE_LOWERCASE=true
PASSWORD_REQUIRE_NUMBERS=true
PASSWORD_REQUIRE_SYMBOLS=true

# Session security
SESSION_SECURE_COOKIES=true
SESSION_SAME_SITE=strict
SESSION_TIMEOUT_MINUTES=60

# Rate limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_REQUESTS=100
RATE_LIMIT_WINDOW_MINUTES=15
```

#### Cultural Data Protection

```bash
# Elder content protection
ELDER_CONTENT_PROTECTION=true
ELDER_ACCESS_LOGGING=true

# Community data isolation
COMMUNITY_DATA_ISOLATION=strict
CROSS_COMMUNITY_ACCESS=false

# Super admin restrictions
SUPER_ADMIN_CULTURAL_ACCESS=false
SUPER_ADMIN_AUDIT_LOGGING=true
```

### Firewall Configuration

```bash
# Basic UFW firewall setup
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# For field kit (local access only)
sudo ufw allow from 192.168.4.0/24 to any port 3000
```

---

## 💾 Backup & Recovery Procedures

### Production Backup Strategy

#### Automated Database Backups

```bash
#!/bin/bash
# /opt/terrastories/backup-db.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/terrastories/backups"
DB_NAME="terrastories_production"

# Create backup directory
mkdir -p $BACKUP_DIR

# PostgreSQL backup with compression
pg_dump -h localhost -U terrastories_user -W $DB_NAME | gzip > $BACKUP_DIR/db_backup_$DATE.sql.gz

# Encrypt backup (for cultural data protection)
gpg --cipher-algo AES256 --compress-algo 1 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65536 --symmetric --output $BACKUP_DIR/db_backup_$DATE.sql.gz.gpg $BACKUP_DIR/db_backup_$DATE.sql.gz

# Remove unencrypted backup
rm $BACKUP_DIR/db_backup_$DATE.sql.gz

# Keep only last 30 days
find $BACKUP_DIR -name "db_backup_*.sql.gz.gpg" -mtime +30 -delete

echo "Database backup completed: db_backup_$DATE.sql.gz.gpg"
```

#### Media File Backups

```bash
#!/bin/bash
# /opt/terrastories/backup-media.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/terrastories/backups"
MEDIA_DIR="/opt/terrastories/data/uploads"

# Create compressed media backup
tar -czf $BACKUP_DIR/media_backup_$DATE.tar.gz -C $MEDIA_DIR .

# Encrypt media backup
gpg --cipher-algo AES256 --symmetric --output $BACKUP_DIR/media_backup_$DATE.tar.gz.gpg $BACKUP_DIR/media_backup_$DATE.tar.gz

# Remove unencrypted backup
rm $BACKUP_DIR/media_backup_$DATE.tar.gz

echo "Media backup completed: media_backup_$DATE.tar.gz.gpg"
```

#### Automated Backup Schedule

```bash
# Add to crontab: sudo crontab -e
# Daily database backup at 2 AM
0 2 * * * /opt/terrastories/backup-db.sh

# Weekly media backup on Sundays at 3 AM
0 3 * * 0 /opt/terrastories/backup-media.sh
```

### Field Kit Backup Strategy

#### Local Backup Script

```bash
#!/bin/bash
# field-kit-backup.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/ubuntu/terrastories-api/backups"
DB_FILE="/home/ubuntu/terrastories-api/data/terrastories_field_kit.db"

mkdir -p $BACKUP_DIR

# SQLite database backup
sqlite3 $DB_FILE ".backup $BACKUP_DIR/field_kit_backup_$DATE.db"

# Media files backup
tar -czf $BACKUP_DIR/field_kit_media_$DATE.tar.gz -C /home/ubuntu/terrastories-api/data/uploads .

# Copy to USB drive if available
if [ -d "/media/usb_backup" ]; then
    cp $BACKUP_DIR/field_kit_backup_$DATE.db /media/usb_backup/
    cp $BACKUP_DIR/field_kit_media_$DATE.tar.gz /media/usb_backup/
    echo "Backup copied to USB drive"
fi

echo "Field Kit backup completed"
```

---

## 🔍 Monitoring & Maintenance

### Health Monitoring

#### Application Health Check

```bash
#!/bin/bash
# health-check.sh - Monitor Terrastories API health

API_URL="http://localhost:3000/health"
EMAIL="admin@community.org"

# Check API health
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" $API_URL)

if [ $RESPONSE != "200" ]; then
    echo "ALERT: Terrastories API is down (HTTP $RESPONSE)" | mail -s "Terrastories Alert" $EMAIL

    # Attempt restart
    sudo systemctl restart terrastories-api

    echo "$(date): API restart attempted due to health check failure" >> /var/log/terrastories-health.log
fi
```

#### Database Health Check

```bash
#!/bin/bash
# db-health-check.sh

DB_NAME="terrastories_production"

# Check PostgreSQL connection
if pg_isready -h localhost -p 5432; then
    echo "$(date): Database is accessible" >> /var/log/terrastories-health.log
else
    echo "$(date): Database connection failed" >> /var/log/terrastories-health.log
    echo "ALERT: Database connection failed" | mail -s "Terrastories DB Alert" admin@community.org
fi

# Check database size (for storage planning)
DB_SIZE=$(psql -h localhost -U terrastories_user -d $DB_NAME -t -c "SELECT pg_size_pretty(pg_database_size('$DB_NAME'));")
echo "$(date): Database size: $DB_SIZE" >> /var/log/terrastories-health.log
```

### Log Management

#### Log Rotation Configuration

```bash
# /etc/logrotate.d/terrastories
/var/log/terrastories/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 ubuntu ubuntu
    postrotate
        systemctl reload terrastories-api
    endscript
}
```

---

## 🚀 Community Onboarding Process

### 1. Pre-Deployment Community Consultation

#### Community Leadership Meeting

- **Participants**: Community leaders, elders, technical contacts
- **Topics**:
  - Platform capabilities and cultural protections
  - Data sovereignty principles and implementation
  - User roles and permissions (admin, editor, viewer, elder)
  - Content guidelines and cultural protocols
  - Training needs assessment

#### Cultural Protocol Definition

- **Elder Content Guidelines**: Define what content requires elder-only access
- **Community Data Policies**: Establish rules for story, place, and speaker data
- **Access Control Policies**: Define user roles and permissions
- **Audit Requirements**: Determine logging and oversight needs

### 2. Technical Setup Phase

#### Infrastructure Deployment

1. Choose deployment scenario (cloud, local server, or field kit)
2. Install and configure system according to this guide
3. Run initial security and cultural protocol tests
4. Create initial administrator account

#### Community Data Setup

```bash
# Create initial community
npm run setup:community -- --name "Your Community Name" --locale "your_locale"

# Create first admin user
npm run create:admin -- --email admin@community.org --name "Community Admin"

# Test cultural protocols
npm test -- --run tests/production/cultural-sovereignty.test.ts
```

### 3. User Training Program

#### Administrator Training (2-3 hours)

- System administration basics
- User management and role assignment
- Backup and recovery procedures
- Cultural protocol configuration
- Troubleshooting common issues

#### Content Creator Training (1-2 hours)

- Creating and managing stories
- Adding places with geographic information
- Managing speakers and cultural roles
- Understanding elder-only content restrictions
- Media upload and management

#### Community Member Training (30-60 minutes)

- Accessing and browsing stories
- Using search and filtering
- Understanding cultural access levels
- Mobile and offline access (if applicable)

### 4. Go-Live Support

#### Initial Launch Support (2 weeks)

- Daily health monitoring
- Immediate technical support for issues
- User feedback collection and response
- Performance monitoring and optimization

#### Ongoing Support Plan

- Monthly health reports
- Quarterly backup verification
- Annual security updates
- Community feedback integration

---

## 🆘 Troubleshooting Guide

### Common Issues

#### Application Won't Start

```bash
# Check logs
sudo journalctl -u terrastories-api -f

# Check environment configuration
npm run config:validate

# Verify database connection
npm run db:test-connection

# Restart services
sudo systemctl restart terrastories-api
```

#### Database Connection Issues

```bash
# For PostgreSQL
pg_isready -h localhost -p 5432

# Check database exists
psql -h localhost -U terrastories_user -l

# For SQLite (field kit)
sqlite3 data/terrastories_field_kit.db ".tables"
```

#### File Upload Issues

```bash
# Check upload directory permissions
ls -la data/uploads
sudo chown -R ubuntu:ubuntu data/uploads
sudo chmod -R 755 data/uploads

# Check disk space
df -h
```

#### Performance Issues

```bash
# Monitor system resources
htop

# Check database performance
npm run db:analyze-performance

# Monitor API response times
curl -w "@curl-format.txt" -s http://localhost:3000/health
```

### Emergency Contacts

#### Technical Support

- **Community Tech Lead**: [contact information]
- **Terrastories Support**: [contact information]
- **Emergency Hotline**: [24/7 support number if available]

#### Cultural Consultation

- **Community Elder Council**: [contact information]
- **Cultural Protocol Advisor**: [contact information]

---

## 📞 Support & Resources

### Documentation Links

- **Main Setup Guide**: [docs/SETUP.md](./SETUP.md)
- **API Documentation**: [docs/3-API_ENDPOINTS.md](./3-API_ENDPOINTS.md)
- **Migration Report**: [docs/MIGRATION_COMPLETION_REPORT.md](./MIGRATION_COMPLETION_REPORT.md)
- **Terrastories Context**: [docs/TERRASTORIES_CONTEXT.md](./TERRASTORIES_CONTEXT.md)

### Community Resources

- **Terrastories Website**: https://terrastories.org
- **Community Forum**: [forum link if available]
- **GitHub Repository**: https://github.com/Terrastories/terrastories-api
- **Indigenous Digital Rights Resources**: [relevant links]

### Training Materials

- **Video Tutorials**: [links to training videos if available]
- **User Guides**: [community-specific guides]
- **Best Practices**: [Indigenous digital storytelling best practices]

---

## 🙏 Acknowledgments

This deployment guide was created with deep respect for Indigenous knowledge systems and in collaboration with Indigenous communities. The Terrastories platform exists to serve Indigenous communities in preserving and sharing their stories through technology while maintaining full control over their cultural data.

**For Indigenous Communities**: Your stories matter, your data sovereignty is paramount, and this technology exists to serve your community's needs and values.

---

**Last Updated**: September 7, 2025  
**Version**: 1.0 (TypeScript API Complete)  
**Next Review**: After first community deployment feedback

---

_This guide is a living document that will be updated based on community feedback and deployment experiences. Your input is valuable for improving this resource._
