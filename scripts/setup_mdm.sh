#!/bin/bash
echo "Setting up Axon MDM server..."

# Install MicroMDM
brew install micromdm 2>/dev/null || \
  curl -L https://github.com/micromdm/micromdm/releases/latest/download/micromdm_darwin_arm64 \
  -o /usr/local/bin/micromdm && chmod +x /usr/local/bin/micromdm

# Create MDM config directory
mkdir -p ~/.axon-mdm

# Generate self-signed certificate for MDM
openssl req -x509 -newkey rsa:4096 \
  -keyout ~/.axon-mdm/server.key \
  -out ~/.axon-mdm/server.crt \
  -days 365 -nodes \
  -subj "/CN=Axon MDM/O=Aretica/C=AU" 2>/dev/null

echo "MDM certificates generated"

# Get Mac's local IP
MAC_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
echo "Mac IP: $MAC_IP"

# Create enrollment profile
cat > ~/.axon-mdm/enrollment.mobileconfig << PROFILE
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.mdm</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadIdentifier</key>
            <string>ai.aretica.axon.mdm</string>
            <key>PayloadUUID</key>
            <string>$(uuidgen)</string>
            <key>PayloadDisplayName</key>
            <string>Axon Personal Monitor</string>
            <key>ServerURL</key>
            <string>https://$MAC_IP:8443/mdm</string>
            <key>CheckInURL</key>
            <string>https://$MAC_IP:8443/checkin</string>
            <key>CheckOutWhenRemoved</key>
            <true/>
            <key>AccessRights</key>
            <integer>8191</integer>
            <key>Topic</key>
            <string>ai.aretica.axon</string>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>Axon Personal Monitor</string>
    <key>PayloadIdentifier</key>
    <string>ai.aretica.axon</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>$(uuidgen)</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
PROFILE

echo ""
echo "MDM enrollment profile created at ~/.axon-mdm/enrollment.mobileconfig"
echo ""
echo "Next steps:"
echo "1. Run: npm run start-mdm-server"
echo "2. On your iPhone: Settings → VPN & Device Management → Install Profile"
echo "3. Or AirDrop the profile file to your iPhone"
echo "4. iPhone will check in every 60 seconds"
