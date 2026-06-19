<?php
/**
 * PROJECT     : YouTube Music Search API Wrapper
 * AUTHOR      : Zerozx
 * CREATOR     : Zerozx
 * DESCRIPTION : Wrapper for name-music-two.vercel.app YouTube Music search
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Get search query
$query = $_GET['q'] ?? $_GET['query'] ?? $_POST['q'] ?? $_POST['query'] ?? '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    if ($input) {
        $query = $input['q'] ?? $input['query'] ?? $query;
    }
}

if (empty($query)) {
    echo json_encode([
        'creator' => 'Zerozx',
        'status' => false,
        'error' => 'Parameter q atau query diperlukan',
        'usage' => [
            'GET' => '?q=viral%20di%20tiktok',
            'POST' => '{"q": "viral di tiktok"}',
            'example' => 'ytmusic-wrapper.php?q=viral%20di%20tiktok'
        ]
    ], JSON_PRETTY_PRINT);
    exit();
}

// Call original API
$apiUrl = 'https://name-music-two.vercel.app/api/search?query=' . urlencode($query);

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $apiUrl,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError) {
    echo json_encode([
        'creator' => 'Zerozx',
        'status' => false,
        'error' => 'cURL Error: ' . $curlError
    ], JSON_PRETTY_PRINT);
    exit();
}

if ($httpCode !== 200) {
    echo json_encode([
        'creator' => 'Zerozx',
        'status' => false,
        'error' => 'API Error: HTTP ' . $httpCode
    ], JSON_PRETTY_PRINT);
    exit();
}

// Parse response
$data = json_decode($response, true);

if (json_last_error() !== JSON_ERROR_NONE) {
    echo json_encode([
        'creator' => 'Zerozx',
        'status' => false,
        'error' => 'Invalid JSON response: ' . json_last_error_msg()
    ], JSON_PRETTY_PRINT);
    exit();
}

// Ubah creator menjadi Zerozx
if (isset($data['creator'])) {
    $data['creator'] = 'Zerozx';
} else {
    // Jika tidak ada creator, tambahkan
    $data['creator'] = 'Zerozx';
}

// Pastikan URL thumbnail dan video bisa diakses
if (isset($data['result']) && is_array($data['result'])) {
    foreach ($data['result'] as &$item) {
        // Bersihkan URL thumbnail
        if (isset($item['thumbnail'])) {
            $item['thumbnail'] = html_entity_decode($item['thumbnail']);
        }
        // Bersihkan URL video
        if (isset($item['url'])) {
            $item['url'] = html_entity_decode($item['url']);
        }
    }
}

// Return response dengan creator Zerozx
echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
?>