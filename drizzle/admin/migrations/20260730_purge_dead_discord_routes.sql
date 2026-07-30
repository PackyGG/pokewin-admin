-- Clears Discord routing rows whose channel the bot no longer reports inside the
-- approved antifraud category boundary. The dispatcher already refuses to deliver
-- to those channels, so the rows were inert; they only made an event look
-- "already assigned to another channel" and blocked editing the live channel.
DELETE FROM discord_notification_routes AS route
WHERE NOT EXISTS (
  SELECT 1
  FROM discord_notification_channels AS owner
  WHERE owner.guild_id = route.guild_id
    AND owner.channel_id = route.channel_id
    AND owner.available = true
);
