<?php
// Topology Graph Generator
namespace Src;

class TopologyGraph {
    public static function generateGraphData($sessions) {
        $nodes = [];
        $edges = [];
        
        // Add user node
        $nodes[] = [
            'id' => 'user',
            'label' => 'You',
            'type' => 'user',
            'status' => 'online',
            'color' => '#00f3ff'
        ];
        
        // Add session nodes
        $modelsUsed = [];
        foreach ($sessions as $session) {
            $nodes[] = [
                'id' => $session['id'],
                'label' => $session['title'],
                'type' => 'session',
                'status' => $session['active'] ? 'active' : 'closed',
                'color' => $session['active'] ? '#7f52ff' : '#ff4757',
                'created' => $session['created_at'] ?? 0,
                'dialog_count' => count($session['dialogs'] ?? [])
            ];
            
            $edges[] = [
                'from' => 'user',
                'to' => $session['id'],
                'type' => 'session',
                'animated' => true
            ];
            
            // Track models used in this session
            if (!empty($session['models_used'])) {
                foreach ($session['models_used'] as $modelId) {
                    if (!in_array($modelId, $modelsUsed)) {
                        $modelsUsed[] = $modelId;
                    }
                }
            }
        }
        
        // Add model nodes
        $models = Config::getModels();
        foreach ($models as $model) {
            if (!$model['active']) continue;
            
            $nodes[] = [
                'id' => 'model_' . $model['id'],
                'label' => $model['name'],
                'type' => 'model',
                'role' => $model['role'],
                'status' => 'available',
                'color' => '#00ff88',
                'provider' => $model['provider'],
                'priority' => $model['priority']
            ];
        }
        
        // Add edges from sessions to models
        foreach ($sessions as $session) {
            if (!empty($session['models_used'])) {
                foreach ($session['models_used'] as $modelId) {
                    $edges[] = [
                        'from' => $session['id'],
                        'to' => 'model_' . $modelId,
                        'type' => 'model_usage',
                        'animated' => false
                    ];
                }
            }
        }
        
        // Add router/API node
        $nodes[] = [
            'id' => 'router',
            'label' => 'Router API',
            'type' => 'router',
            'status' => 'online',
            'color' => '#ff4757'
        ];
        
        // Connect router to user
        $edges[] = [
            'from' => 'user',
            'to' => 'router',
            'type' => 'control',
            'animated' => true
        ];
        
        // Connect router to all active models
        foreach ($models as $model) {
            if ($model['active']) {
                $edges[] = [
                    'from' => 'router',
                    'to' => 'model_' . $model['id'],
                    'type' => 'provider',
                    'animated' => true
                ];
            }
        }
        
        return [
            'nodes' => $nodes,
            'edges' => $edges,
            'timestamp' => time(),
            'session_count' => count($sessions),
            'model_count' => count(array_filter($models, fn($m) => $m['active']))
        ];
    }
    
    public static function renderSVG($graphData) {
        $width = 800;
        $height = 600;
        $nodes = $graphData['nodes'] ?? [];
        $edges = $graphData['edges'] ?? [];
        
        // Simple positioning algorithm
        $positions = [];
        $centerX = $width / 2;
        $centerY = $height / 2;
        
        // Position user at center
        $positions['user'] = ['x' => $centerX, 'y' => $centerY - 100];
        
        // Position router below user
        $positions['router'] = ['x' => $centerX, 'y' => $centerY];
        
        // Position sessions in a circle around center
        $sessionNodes = array_filter($nodes, fn($n) => $n['type'] === 'session');
        $sessionRadius = 200;
        $sessionCount = count($sessionNodes);
        
        $i = 0;
        foreach ($sessionNodes as $node) {
            $angle = ($i / max($sessionCount, 1)) * 2 * M_PI;
            $x = $centerX + $sessionRadius * cos($angle);
            $y = $centerY + 100 + $sessionRadius * sin($angle);
            $positions[$node['id']] = ['x' => $x, 'y' => $y];
            $i++;
        }
        
        // Position models in another circle
        $modelNodes = array_filter($nodes, fn($n) => $n['type'] === 'model');
        $modelRadius = 300;
        $modelCount = count($modelNodes);
        
        $i = 0;
        foreach ($modelNodes as $node) {
            $angle = ($i / max($modelCount, 1)) * 2 * M_PI;
            $x = $centerX + $modelRadius * cos($angle);
            $y = $centerY + 200 + $modelRadius * sin($angle);
            $positions[$node['id']] = ['x' => $x, 'y' => $y];
            $i++;
        }
        
        // Build SVG
        ob_start();
        ?>
        <svg xmlns="http://www.w3.org/2000/svg" width="<?= $width ?>" height="<?= $height ?>" style="background: rgba(10, 10, 26, 0.9); border-radius: 12px;">
            <!-- Draw edges -->
            <?php foreach ($edges as $edge): 
                $from = $positions[$edge['from']] ?? null;
                $to = $positions[$edge['to']] ?? null;
                if (!$from || !$to) continue;
            ?>
                <line x1="<?= $from['x'] ?>" y1="<?= $from['y'] ?>" 
                      x2="<?= $to['x'] ?>" y2="<?= $to['y'] ?>" 
                      stroke="rgba(0, 243, 255, 0.3)" 
                      stroke-width="<?= $edge['type'] === 'control' ? 3 : ($edge['type'] === 'session' ? 2 : 1) ?>"
                      stroke-dasharray="<?= $edge['animated'] ? '5,5' : 'none' ?>">
                    <animate attributeName="stroke-opacity" values="0.3;0.6;0.3" dur="2s" repeatCount="indefinite" />
                </line>
            <?php endforeach; ?>
            
            <!-- Draw nodes -->
            <?php foreach ($nodes as $node): 
                $pos = $positions[$node['id']] ?? ['x' => 0, 'y' => 0];
                $size = 15;
                switch ($node['type']) {
                    case 'user': $size = 30; break;
                    case 'router': $size = 25; break;
                    case 'session': $size = 20; break;
                    case 'model': $size = 18; break;
                }
                $color = $node['color'] ?? '#7f52ff';
            ?>
                <g>
                    <circle cx="<?= $pos['x'] ?>" cy="<?= $pos['y'] ?>" r="<?= $size ?>" 
                            fill="<?= $color ?>" fill-opacity="0.2" 
                            stroke="<?= $color ?>" stroke-width="2">
                        <?php if (($node['status'] ?? '') === 'online' || ($node['status'] ?? '') === 'active'): ?>
                            <animate attributeName="r" values="<?= $size ?>;<?= $size + 2 ?>;<?= $size ?>" 
                                    dur="2s" repeatCount="indefinite" />
                        <?php endif; ?>
                    </circle>
                    <text x="<?= $pos['x'] ?>" y="<?= $pos['y'] + $size + 20 ?>" 
                          text-anchor="middle" fill="var(--text-secondary)" font-size="10">
                        <?= htmlspecialchars($node['label']) ?>
                    </text>
                </g>
            <?php endforeach; ?>
        </svg>
        <?php
        return ob_get_clean();
    }
}