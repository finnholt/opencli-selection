# opencli-plugin-opencli-buyin

An opencli plugin: opencli-buyin

## Install

```bash
# From local development directory
opencli plugin install file:///Users/tengxinde/Documents/Projects/Vue/opencli-buyin

# From GitHub (after publishing)
opencli plugin install github:<user>/opencli-plugin-opencli-buyin
```

## Commands

| Command | Type | Description |
|---------|------|-------------|
| `opencli-buyin/hello` | Pipeline | Sample pipeline command |
| `opencli-buyin/greet` | TypeScript | Sample TS command with func() |

## Development

```bash
# Install locally for development (symlinked, changes reflect immediately)
opencli plugin install file:///Users/tengxinde/Documents/Projects/Vue/opencli-buyin

# Verify commands are registered
opencli list | grep opencli-buyin

# Run a command
opencli opencli-buyin hello
opencli opencli-buyin greet --name World
```
